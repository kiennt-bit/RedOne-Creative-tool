"""Kho tính năng — feature catalog (A1111-style remote index.json) + install/uninstall.

GET  /api/features/catalog    → {tags, features, installed}  (remote → cache → bundled fallback)
GET  /api/features/installed  → {installed}
POST /api/features/install    → {ok, started}   (frontend/asset only; runs in a thread, WS progress)
POST /api/features/uninstall  → {ok}

The catalog is fetched server-side (avoids browser CORS to GitHub) and cached;
when the network is down we serve the last cache, else the bundled fallback so
the Kho still lists what ships with this build.
"""
from __future__ import annotations
import asyncio
import json
import logging
import threading
import time
import urllib.request
from pathlib import Path

from fastapi import APIRouter, HTTPException

from ..config import BASE_DIR, DATA_DIR, FEATURES_INDEX_URL
from ..ws_hub import hub
from ..services import feature_installer as fi

log = logging.getLogger("redone.features")
router = APIRouter(prefix="/api/features", tags=["features"])

_CACHE_FILE = DATA_DIR / "features_cache.json"
_FALLBACK = BASE_DIR / "backend" / "resources" / "features.fallback.json"
_CACHE_TTL = 300.0
_cache: dict = {"ts": 0.0, "data": None}


def _read_fallback() -> dict:
    try:
        return json.loads(_FALLBACK.read_text(encoding="utf-8"))
    except Exception as e:
        log.info("read fallback catalog failed: %s", e)
        return {"tags": {}, "features": []}


def _fetch_remote() -> dict | None:
    if not FEATURES_INDEX_URL:
        return None
    try:
        req = urllib.request.Request(
            FEATURES_INDEX_URL, headers={"User-Agent": "RedOne-Creative"}
        )
        with urllib.request.urlopen(req, timeout=6) as r:  # nosec - fixed config URL
            data = json.loads(r.read().decode("utf-8"))
        if not isinstance(data, dict) or "features" not in data:
            return None
        try:
            _CACHE_FILE.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass
        return data
    except Exception as e:
        log.info("fetch remote catalog failed: %s", e)
        return None


def _load_catalog() -> dict:
    now = time.time()
    if _cache["data"] and (now - _cache["ts"]) < _CACHE_TTL:
        return _cache["data"]
    data = _fetch_remote()
    if data is None:
        try:
            if _CACHE_FILE.exists():
                data = json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
        except Exception:
            data = None
    if data is None:
        data = _read_fallback()
    _cache["ts"] = now
    _cache["data"] = data
    return data


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
