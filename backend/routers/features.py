"""Kho tính năng — feature catalog (đi kèm bản build) + install/uninstall.

GET  /api/features/catalog    → {tags, features, installed}  (catalog nhúng trong app)
GET  /api/features/installed  → {installed}
POST /api/features/install    → {ok, started}   (frontend/asset only; runs in a thread, WS progress)
POST /api/features/uninstall  → {ok}

Catalog KHÔNG gọi remote (bỏ kiểu auto-fetch index.json). Danh sách tính năng đi
kèm theo bản build — chỉ thay đổi khi user cài bản app mới. File catalog nằm ở
backend/resources/features.fallback.json (đã bundle vào EXE qua RedOne.spec).
"""
from __future__ import annotations
import asyncio
import json
import logging
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException

from ..config import BASE_DIR
from ..ws_hub import hub
from ..services import feature_installer as fi

log = logging.getLogger("redone.features")
router = APIRouter(prefix="/api/features", tags=["features"])

_CATALOG = BASE_DIR / "backend" / "resources" / "features.fallback.json"


def _load_catalog() -> dict:
    """Danh sách tính năng đi kèm bản build (chỉ đổi khi user cài bản app mới).
    Đọc thẳng catalog nhúng trong app — KHÔNG gọi remote, KHÔNG cache."""
    try:
        return json.loads(_CATALOG.read_text(encoding="utf-8"))
    except Exception as e:
        log.info("read feature catalog failed: %s", e)
        return {"tags": {}, "features": []}


def _find_feature(fid: str) -> dict | None:
    for f in _load_catalog().get("features", []):
        if f.get("id") == fid:
            return f
    return None


@router.get("/catalog")
async def catalog():
    data = await asyncio.to_thread(_load_catalog)
    installed = await asyncio.to_thread(fi.load_installed)
    return {
        "tags": data.get("tags", {}),
        "features": data.get("features", []),
        "installed": installed,
    }


@router.get("/installed")
async def installed():
    return {"installed": await asyncio.to_thread(fi.load_installed)}


@router.post("/install")
async def install(body: dict):
    fid = (body or {}).get("id")
    feat = _find_feature(fid) if fid else None
    if not feat:
        raise HTTPException(404, "Không tìm thấy tính năng trong catalog")
    kind = feat.get("kind")
    if kind not in ("frontend", "asset"):
        raise HTTPException(400, f"Kind '{kind}' không cần tải (builtin bật ở client)")

    loop = asyncio.get_running_loop()

    def emit(pct: float, stage: str, msg: str):
        payload = {"id": fid, "percent": round(pct, 1), "stage": stage, "message": msg}
        try:
            asyncio.run_coroutine_threadsafe(
                hub.broadcast("feature_install_progress", payload), loop
            )
        except Exception:
            pass

    def worker():
        try:
            if kind == "frontend":
                fi.install_frontend(feat, emit)
            else:
                fi.install_asset(feat, emit)
            asyncio.run_coroutine_threadsafe(
                hub.broadcast("feature_installed",
                              {"id": fid, "version": feat.get("version", "")}), loop
            )
        except Exception as e:
            log.warning("install %s failed: %s", fid, e)
            asyncio.run_coroutine_threadsafe(
                hub.broadcast("feature_install_error", {"id": fid, "error": str(e)}), loop
            )

    threading.Thread(target=worker, daemon=True).start()
    return {"ok": True, "id": fid, "started": True}


@router.post("/uninstall")
async def uninstall(body: dict):
    fid = (body or {}).get("id")
    if not fid:
        raise HTTPException(400, "Thiếu id")
    await asyncio.to_thread(fi.uninstall_feature, fid)
    await hub.broadcast("feature_uninstalled", {"id": fid})
    return {"ok": True, "id": fid}
