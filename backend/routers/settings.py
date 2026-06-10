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
    # Multiple Gemini API keys for automatic rotation: when one hits its
    # free-tier quota, generate_text() falls through to the next. Saving this
    # supersedes (and migrates away from) the single gemini_api_key.
    gemini_api_keys: list[str] | None = None
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
    auth_mode: str | None = None          # "extension" | "playwright" | "vertex_api"
    # Vertex AI commercial mode config — used only when auth_mode = "vertex_api".
    # Image gen uses the API key (Gemini); video gen needs the service
    # account JSON path (ADC). See services/vertex_client.py.
    vertex_api_key: str | None = None
    vertex_service_account_path: str | None = None
    vertex_project_id: str | None = None
    vertex_region: str | None = None      # "us-central1" default
    # Random pause between batches. Each batch finishes → tool sleeps a
    # uniform random number of seconds in [min, max] before launching the
    # next batch. Helps reduce Google's rate-based bot detection — the
    # randomization in particular avoids the "consistent N-second gap"
    # signature that flagged constant cooldowns. 0/0 = no wait.
    batch_cooldown_min_seconds: int | None = None
    batch_cooldown_max_seconds: int | None = None


def _mask_key(v: str) -> str:
    return (v[:4] + "•••" + v[-4:]) if isinstance(v, str) and len(v) > 8 else "•••"


@router.get("")
async def get_settings():
    s = db.all_settings()
    if "gemini_api_key" in s:
        v = s["gemini_api_key"]
        if isinstance(v, str) and len(v) > 8:
            s["gemini_api_key_masked"] = v[:4] + "•••" + v[-4:]
        else:
            s["gemini_api_key_masked"] = "•••"

    # Multi-key list for the rotation UI. Synthesize from the stored list, or
    # fall back to the legacy single key so old installs still show a key. The
    # raw list is returned so the settings textarea is editable (localhost,
    # single trusted user — same trust model as the existing single key).
    gkeys = s.get("gemini_api_keys")
    if not isinstance(gkeys, list):
        single = s.get("gemini_api_key")
        gkeys = [single] if isinstance(single, str) and single.strip() else []
    gkeys = [k for k in gkeys if isinstance(k, str) and k.strip()]
    s["gemini_api_keys"] = gkeys
    s["gemini_api_keys_masked"] = [_mask_key(k) for k in gkeys]
    # Same masking for Vertex AI API key — don't leak the secret in
    # plain text over the wire.
    if "vertex_api_key" in s:
        v = s["vertex_api_key"]
        if isinstance(v, str) and len(v) > 8:
            s["vertex_api_key_masked"] = v[:6] + "•••" + v[-4:]
            del s["vertex_api_key"]   # frontend uses masked version
        elif v:
            s["vertex_api_key_masked"] = "•••"
            del s["vertex_api_key"]

    # Tell the frontend whether private_config.py is providing the
    # Vertex AI credentials. When True, Settings UI shows the fields as
    # read-only "Loaded from private_config" so end users don't
    # accidentally type over the admin-baked values.
    #
    # Detection: service account path + project_id are the actual
    # required fields (API key path was deprecated). If both are set
    # to real values (not template placeholders), private_config wins.
    private_config_active = False
    try:
        from .. import private_config as _pc  # type: ignore
        pc_sa_path = getattr(_pc, "VERTEX_SERVICE_ACCOUNT_PATH", "") or ""
        pc_project = getattr(_pc, "VERTEX_PROJECT_ID", "") or ""
        pc_region  = getattr(_pc, "VERTEX_REGION", "us-central1") or "us-central1"
        if (
            pc_sa_path and pc_project
            and pc_project not in ("your-project-id-here", "")
        ):
            private_config_active = True
            # Surface the values to the UI so the locked fields actually
            # SHOW what's loaded instead of looking empty. These aren't
            # secrets — path + project ID + region are safe to display.
            s["vertex_service_account_path"] = pc_sa_path
            s["vertex_project_id"] = pc_project
            s["vertex_region"] = pc_region
    except Exception:
        pass
    s["vertex_private_config_active"] = private_config_active
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
    updated = list(payload.keys())
    # Multi-key list: trim + drop blanks, persist as the single source of
    # truth, and clear the legacy single key (folded into the list) so
    # get_api_keys() doesn't append a stale duplicate.
    if payload.get("gemini_api_keys") is not None:
        clean = [k.strip() for k in payload["gemini_api_keys"]
                 if isinstance(k, str) and k.strip()]
        db.set_setting("gemini_api_keys", clean)
        db.set_setting("gemini_api_key", "")
        payload.pop("gemini_api_keys", None)
    for k, v in payload.items():
        if v is not None:
            db.set_setting(k, v)
    return {"ok": True, "updated": updated}


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
