"""Admin tracking API — usage stats from Firebase Firestore.

Endpoints:
  GET  /api/tracking/status          — is tracking enabled + is current user admin?
  GET  /api/tracking/stats           — all users' aggregated stats (admin only)
  GET  /api/tracking/stats/{email}   — daily breakdown for one user (admin only)
  POST /api/tracking/heartbeat       — session heartbeat (called by frontend)

Access control:
  - /stats and /stats/{email} require the logged-in user's email to be in
    TRACKING_ADMIN_EMAILS (config.py / private_config.py).
  - /status returns is_admin so the frontend can show/hide the Tracking tab.
  - /heartbeat is called automatically by any logged-in user's frontend.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from ..config import TRACKING_ADMIN_EMAILS
from ..services import tracking as tracking_service
from ..services.oauth_auth import load_session

log = logging.getLogger("redone.tracking")
router = APIRouter(prefix="/api/tracking", tags=["tracking"])


def _current_email() -> str:
    """Get current logged-in user's email, or empty string."""
    sess = load_session()
    return (sess.get("email") or "").lower().strip() if sess else ""


def _is_admin() -> bool:
    """Check if the current user is in the tracking admin whitelist.

    Checks both:
    1. Hardcoded TRACKING_ADMIN_EMAILS in config.py (bootstrap admins)
    2. Firestore tracking_roles collection (dynamic admins)
    """
    email = _current_email()
    if not email:
        return False
    # 1. Check config.py whitelist (sync, fast)
    if email in TRACKING_ADMIN_EMAILS:
        return True
    # 2. Check Firestore (sync — called from sync context)
    try:
        role_doc = tracking_service._get_role_sync(email)
        return role_doc is not None and role_doc.get("role") == "admin"
    except Exception:
        return False


def _require_admin() -> None:
    """Raise 403 if the caller is not a tracking admin."""
    if not _is_admin():
        raise HTTPException(
            status_code=403,
            detail="Chỉ admin mới xem được trang Tracking",
        )


@router.get("/status")
async def tracking_status():
    """Whether Firebase tracking is enabled + whether current user is admin."""
    return {
        "enabled": tracking_service.is_enabled(),
        "is_admin": _is_admin(),
    }


@router.get("/stats")
async def all_stats():
    """All users' aggregated stats — admin only."""
    _require_admin()
    if not tracking_service.is_enabled():
        raise HTTPException(
            status_code=503,
            detail="Firebase tracking chưa được cấu hình",
        )
    data = await tracking_service.get_all_stats()
    return data


@router.get("/stats/{email}")
async def user_daily(email: str, days: int = 30):
    """Daily breakdown for a specific user — admin only."""
    _require_admin()
    if not tracking_service.is_enabled():
        raise HTTPException(
            status_code=503,
            detail="Firebase tracking chưa được cấu hình",
        )
    data = await tracking_service.get_user_daily(email, days=days)
    return data


@router.post("/heartbeat")
async def heartbeat():
    """Session heartbeat — called periodically by the frontend to track
    how long the user has the tool open."""
    email = _current_email()
    if not email:
        return {"ok": False, "reason": "not_logged_in"}
    sess = load_session()
    name = (sess.get("name") or "") if sess else ""
    await tracking_service.heartbeat(email, display_name=name)
    return {"ok": True}


# ── Role Management Endpoints ─────────────────────────────────────────

@router.get("/roles")
async def list_roles():
    """List all user roles — admin only."""
    _require_admin()
    roles = await tracking_service.list_roles()
    return {"roles": roles}


@router.post("/roles")
async def add_role(payload: dict):
    """Add or update a user role — admin only.

    Body: { "email": "user@redone.vn", "role": "admin"|"design"|"seo" }
    """
    _require_admin()
    email = (payload.get("email") or "").lower().strip()
    role = (payload.get("role") or "").lower().strip()
    if not email or "@" not in email:
        raise HTTPException(400, "Email không hợp lệ")
    if role not in tracking_service.VALID_ROLES:
        raise HTTPException(
            400,
            f"Role không hợp lệ. Chọn: {', '.join(tracking_service.VALID_ROLES)}",
        )
    added_by = _current_email()
    result = await tracking_service.set_role(email, role, added_by=added_by)
    return {"ok": True, **result}


@router.put("/roles/{email}")
async def update_role(email: str, payload: dict):
    """Update a user's role — admin only.

    Body: { "role": "admin"|"design"|"seo" }
    """
    _require_admin()
    role = (payload.get("role") or "").lower().strip()
    if role not in tracking_service.VALID_ROLES:
        raise HTTPException(
            400,
            f"Role không hợp lệ. Chọn: {', '.join(tracking_service.VALID_ROLES)}",
        )
    added_by = _current_email()
    result = await tracking_service.set_role(email, role, added_by=added_by)
    return {"ok": True, **result}


@router.delete("/roles/{email}")
async def remove_role(email: str):
    """Remove a user's role — admin only.

    Cannot remove bootstrap admins (defined in config.py).
    """
    _require_admin()
    email_lower = email.lower().strip()
    if email_lower in TRACKING_ADMIN_EMAILS:
        raise HTTPException(
            400,
            "Không thể xóa bootstrap admin (cấu hình trong config.py)",
        )
    deleted = await tracking_service.delete_role(email_lower)
    if not deleted:
        raise HTTPException(404, "Không tìm thấy user")
    return {"ok": True}

