"""Kho tính năng — feature catalog (remote + fallback) + install/uninstall.

GET  /api/features/catalog    → {tags, features, installed}
GET  /api/features/installed  → {installed}
POST /api/features/install    → {ok, started}   (frontend/asset only; runs in a thread, WS progress)
POST /api/features/uninstall  → {ok}

Catalog loading priority:
  1. Remote index.json from GitHub (config.FEATURES_INDEX_URL)
  2. Cached copy (data/features_cache.json) — used when remote is unreachable
  3. Bundled fallback (backend/resources/features.fallback.json) — ships in EXE

Remote fetch benefits: add/edit features by pushing to GitHub — no EXE rebuild.
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

_FALLBACK = BASE_DIR / "backend" / "resources" / "features.fallback.json"
_CACHE = DATA_DIR / "features_cache.json"

# In-memory cache — refreshed at most once every 10 minutes.
_catalog_mem: dict | None = None
_catalog_ts: float = 0.0
_CACHE_TTL = 600.0  # 10 min


def _fetch_remote() -> dict | None:
    """Fetch the remote index.json (timeout 8s). Returns None on any failure."""
    url = FEATURES_INDEX_URL
    if not url:
        return None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "RedOne-Creative"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        # Persist to disk cache for offline fallback
        try:
            _CACHE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass
        log.debug("features: fetched remote catalog (%d features)", len(data.get("features", [])))
        return data
    except Exception as e:
        log.debug("features: remote fetch failed: %s", e)
        return None


def _load_cache() -> dict | None:
    """Read the on-disk cache (from a previous successful remote fetch)."""
    try:
        if _CACHE.exists():
            return json.loads(_CACHE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return None


def _load_fallback() -> dict:
    """Read the bundled fallback catalog (always present in EXE)."""
    try:
        return json.loads(_FALLBACK.read_text(encoding="utf-8"))
    except Exception as e:
        log.warning("features: fallback catalog read failed: %s", e)
        return {"tags": {}, "features": []}


def _load_catalog() -> dict:
    """Load catalog: remote → cache → fallback. Caches in memory for _CACHE_TTL."""
    global _catalog_mem, _catalog_ts
    now = time.time()
    if _catalog_mem and (now - _catalog_ts) < _CACHE_TTL:
        return _catalog_mem

    data = _fetch_remote()
    if not data:
        data = _load_cache()
    if not data:
        data = _load_fallback()

    _catalog_mem = data
    _catalog_ts = now
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
