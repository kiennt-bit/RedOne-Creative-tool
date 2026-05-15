"""System info + update-check endpoints."""
from __future__ import annotations
import logging
from fastapi import APIRouter

from ..config import APP_NAME, APP_VERSION, GITHUB_REPO, IS_FROZEN, OUTPUT_DIR, DATA_DIR
from ..services.updater import check_for_update

log = logging.getLogger("navtools.system")
router = APIRouter(prefix="/api/system", tags=["system"])


@router.get("/info")
async def info():
    """Static app info."""
    return {
        "app_name": APP_NAME,
        "version": APP_VERSION,
        "frozen": IS_FROZEN,
        "github_repo": GITHUB_REPO,
        "github_url": f"https://github.com/{GITHUB_REPO}",
        "data_dir": str(DATA_DIR),
        "output_dir": str(OUTPUT_DIR),
    }


@router.get("/check-update")
async def check_update(force: bool = False):
    """Check GitHub releases for a newer version. Cached 5 min."""
    return await check_for_update(force=force)
