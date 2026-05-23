"""Settings and system info endpoints."""
from __future__ import annotations
import logging
import sys
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..database import db
from ..config import APP_NAME, APP_VERSION, OUTPUT_DIR

log = logging.getLogger("navtools.settings")
router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsUpdate(BaseModel):
    gemini_api_key: str | None = None
    output_folder: str | None = None
    default_quality: str | None = None
    default_aspect: str | None = None
    theme: str | None = None
    auto_rotate_accounts: bool | None = None
    auto_save_outputs: bool | None = None
    browser_backend: str | None = None    # "chrome" | "cloak" (legacy, only when auth_mode=playwright)
    # New: route all Google calls through the Chrome extension bridge
    # instead of Playwright. Default "extension" — proven to dramatically
    # reduce 403 cascades (token comes from user's real Chrome).
    auth_mode: str | None = None          # "extension" | "playwright"
    # Random pause between batches. Each batch finishes → tool sleeps a
    # uniform random number of seconds in [min, max] before launching the
    # next batch. Helps reduce Google's rate-based bot detection — the
    # randomization in particular avoids the "consistent N-second gap"
    # signature that flagged constant cooldowns. 0/0 = no wait.
    batch_cooldown_min_seconds: int | None = None
    batch_cooldown_max_seconds: int | None = None


@router.get("")
async def get_settings():
    s = db.all_settings()
    if "gemini_api_key" in s:
        v = s["gemini_api_key"]
        if isinstance(v, str) and len(v) > 8:
            s["gemini_api_key_masked"] = v[:4] + "•••" + v[-4:]
        else:
            s["gemini_api_key_masked"] = "•••"
    return {
        "settings": s,
        "app": {
            "name": APP_NAME,
            "version": APP_VERSION,
            "output_dir": str(OUTPUT_DIR),
            "python": sys.version.split()[0],
        },
    }


@router.post("")
async def update_settings(body: SettingsUpdate):
    payload = body.model_dump(exclude_unset=True)
    for k, v in payload.items():
        if v is not None:
            db.set_setting(k, v)
    return {"ok": True, "updated": list(payload.keys())}


@router.get("/cloak-status")
async def cloak_status():
    """Check whether CloakBrowser package is installed and binary is cached."""
    from ..services.cloak_backend import is_available
    installed, err = is_available()
    info: dict = {"installed": installed, "error": err}
    if installed:
        try:
            import cloakbrowser
            info["version"] = getattr(cloakbrowser, "__version__", "unknown")
            try:
                bi = cloakbrowser.binary_info()
                info["binary"] = bi
            except Exception as e:
                info["binary_error"] = str(e)
        except Exception as e:
            info["error"] = str(e)
    return info


@router.post("/test-gemini")
async def test_gemini():
    from ..services.gemini import generate_text
    try:
        result = await generate_text("Say 'OK' in one word.")
        return {"ok": True, "text": result["text"], "model": result["model_used"]}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.get("/logs")
async def get_logs(limit: int = 200):
    """Tail recent logs from the app log file (if present)."""
    log_file = Path(OUTPUT_DIR).parent / "data" / "app.log"
    if not log_file.exists():
        return {"lines": [], "path": str(log_file)}
    try:
        text = log_file.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()[-limit:]
        return {"lines": lines, "path": str(log_file)}
    except Exception as e:
        return {"lines": [], "error": str(e)}
