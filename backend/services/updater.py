"""GitHub-based update checker.

Polls the releases API on demand (not in a background loop — frontend triggers
the check). Compares the latest published tag against the bundled APP_VERSION.
"""
from __future__ import annotations
import asyncio
import logging
import re
from typing import Optional

import httpx

from ..config import APP_VERSION, GITHUB_REPO

log = logging.getLogger("navtools.updater")

_CACHE: dict = {"data": None, "ts": 0}
_CACHE_TTL_SECONDS = 300  # 5 min — avoid GitHub rate limits


def _parse_version(v: str) -> tuple[int, ...]:
    """Strip leading 'v', split on dots, return int tuple. Falls back to (0,)."""
    v = (v or "").lstrip("vV").strip()
    parts = re.split(r"[.\-+]", v)
    out: list[int] = []
    for p in parts:
        m = re.match(r"^(\d+)", p)
        if m:
            out.append(int(m.group(1)))
        else:
            break
    return tuple(out) or (0,)


def _is_newer(remote: str, local: str) -> bool:
    return _parse_version(remote) > _parse_version(local)


async def check_for_update(force: bool = False) -> dict:
    """Return {update_available, current, latest, release_url, download_url}."""
    import time
    now = time.time()
    if not force and _CACHE["data"] and (now - _CACHE["ts"] < _CACHE_TTL_SECONDS):
        return _CACHE["data"]

    url = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "RedOne-Creative-Updater"}
    result = {
        "update_available": False,
        "current": APP_VERSION,
        "latest": None,
        "release_url": None,
        "download_url": None,
        "release_notes": None,
        "published_at": None,
        "error": None,
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(url, headers=headers)
            if r.status_code == 404:
                result["error"] = "Chưa có release nào trên GitHub repo"
                _CACHE["data"] = result
                _CACHE["ts"] = now
                return result
            r.raise_for_status()
            data = r.json()

        tag = data.get("tag_name") or ""
        result["latest"] = tag.lstrip("vV")
        result["release_url"] = data.get("html_url")
        result["release_notes"] = (data.get("body") or "").strip()[:1500]
        result["published_at"] = data.get("published_at")

        # Find a .exe / .zip asset to suggest as direct download
        for asset in data.get("assets", []):
            name = (asset.get("name") or "").lower()
            if name.endswith(".exe") or name.endswith(".zip"):
                result["download_url"] = asset.get("browser_download_url")
                break

        result["update_available"] = _is_newer(result["latest"], APP_VERSION)
        log.info(
            f"Update check: current={APP_VERSION} latest={result['latest']} "
            f"available={result['update_available']}"
        )
    except Exception as e:
        log.warning(f"Update check failed: {e}")
        result["error"] = str(e)

    _CACHE["data"] = result
    _CACHE["ts"] = now
    return result
