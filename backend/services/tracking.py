"""Firebase Firestore usage-tracking service.

Centralised behavioural tracking: every local tool instance reports
events (image / video / script / storyboard created) and heartbeats
(session time) to Cloud Firestore so admins can monitor all users.

Design principles (mirrors hub_client.py):
  - BEST-EFFORT: if Firebase is disabled or unreachable, every public
    function is a silent no-op → generation never blocks on tracking.
  - Lazy init: the SDK is only imported / initialised on first use.
  - Thread-safe: all writes go through asyncio.to_thread() so they
    never block the FastAPI event loop.

Firestore schema (collection: ``usage_tracking``):
  usage_tracking/{email_key}          — per-user aggregate doc
    ├─ email, display_name, first_seen_at, last_active_at
    ├─ total_images, total_videos, total_scripts, total_storyboards
    ├─ total_session_seconds
    └─ daily/{YYYY-MM-DD}            — per-day detail subcollection
         ├─ images, videos, scripts, storyboards
         ├─ active_seconds
         └─ last_heartbeat
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any, Optional

from ..config import (
    FIREBASE_PROJECT_ID,
    FIREBASE_TRACKING_ENABLED,
    FIREBASE_HEARTBEAT_INTERVAL_S,
)

log = logging.getLogger("redone.tracking")

# ── Module-level state ────────────────────────────────────────────────
_firestore_client = None      # lazy-init Firestore client
_initialised = False
_init_failed = False           # don't retry after first failure


def is_enabled() -> bool:
    """Check if tracking is configured and enabled."""
    return bool(FIREBASE_TRACKING_ENABLED and FIREBASE_PROJECT_ID)


# ── Lazy Firebase initialisation ──────────────────────────────────────

def _get_db():
    """Return the Firestore client, initialising on first call.

    Uses the same GCP service-account credentials as Vertex AI
    (``VERTEX_SERVICE_ACCOUNT_INFO`` in private_config.py).
    """
    global _firestore_client, _initialised, _init_failed
    if _init_failed:
        return None
    if _initialised:
        return _firestore_client
    try:
        import firebase_admin                                      # type: ignore
        from firebase_admin import credentials, firestore           # type: ignore

        # Use the hardcoded service-account from config.py (ships with update)
        cred = None
        try:
            from ..config import FIREBASE_SERVICE_ACCOUNT_INFO as _sa
            if isinstance(_sa, dict) and _sa.get("project_id"):
                cred = credentials.Certificate(_sa)
        except Exception:
            pass

        if cred is None:
            # Fallback: Application Default Credentials
            cred = credentials.ApplicationDefault()

        # Only init if no default app exists yet (guard for hot-reload)
        try:
            firebase_admin.get_app()
        except ValueError:
            firebase_admin.initialize_app(cred, {
                "projectId": FIREBASE_PROJECT_ID,
            })

        _firestore_client = firestore.client()
        _initialised = True
        log.info("Firebase tracking initialised (project=%s)", FIREBASE_PROJECT_ID)
        return _firestore_client
    except Exception as e:
        _init_failed = True
        log.warning("Firebase tracking init failed (tracking disabled): %s", e)
        return None


def _email_key(email: str) -> str:
    """Firestore doc IDs can't contain '/' — replace '@' and '.' for safety."""
    return email.lower().replace("@", "_at_").replace(".", "_")


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


# ── Synchronous helpers (run in threadpool) ───────────────────────────

def _track_event_sync(
    email: str,
    event_type: str,
    count: int = 1,
    display_name: str = "",
) -> None:
    """Write a tracking event to Firestore (blocking).

    ``event_type`` must be one of:
      ``image_created``, ``video_created``, ``script_created``, ``storyboard_created``
    """
    db = _get_db()
    if db is None:
        return

    field_map = {
        "image_created": "images",
        "video_created": "videos",
        "script_created": "scripts",
        "storyboard_created": "storyboards",
    }
    field = field_map.get(event_type)
    if not field:
        log.warning("tracking: unknown event_type=%s", event_type)
        return

    from firebase_admin import firestore as _fs  # type: ignore
    key = _email_key(email)
    now = datetime.now(timezone.utc)
    today = _today()

    user_ref = db.collection("usage_tracking").document(key)
    daily_ref = user_ref.collection("daily").document(today)

    # Atomic increment on the aggregate doc
    user_ref.set({
        "email": email.lower(),
        "display_name": display_name or email.split("@")[0],
        f"total_{field}": _fs.Increment(count),
        "last_active_at": now,
    }, merge=True)

    # Ensure first_seen_at is set only once
    user_ref.set({"first_seen_at": now}, merge=True)

    # Daily detail
    daily_ref.set({
        field: _fs.Increment(count),
        "last_heartbeat": now,
    }, merge=True)


def _heartbeat_sync(email: str, display_name: str = "") -> None:
    """Record a session heartbeat (blocking).

    Called every ``FIREBASE_HEARTBEAT_INTERVAL_S`` seconds while the tool
    is open.  Increments ``active_seconds`` by the heartbeat interval.
    """
    db = _get_db()
    if db is None:
        return

    from firebase_admin import firestore as _fs  # type: ignore
    key = _email_key(email)
    now = datetime.now(timezone.utc)
    today = _today()

    interval = FIREBASE_HEARTBEAT_INTERVAL_S

    user_ref = db.collection("usage_tracking").document(key)
    daily_ref = user_ref.collection("daily").document(today)

    user_ref.set({
        "email": email.lower(),
        "display_name": display_name or email.split("@")[0],
        "total_session_seconds": _fs.Increment(interval),
        "last_active_at": now,
    }, merge=True)

    # Ensure first_seen_at is set only once
    user_ref.set({"first_seen_at": now}, merge=True)

    daily_ref.set({
        "active_seconds": _fs.Increment(interval),
        "last_heartbeat": now,
    }, merge=True)


def _get_all_stats_sync() -> list[dict]:
    """Read aggregated stats for ALL users (admin dashboard)."""
    db = _get_db()
    if db is None:
        return []

    docs = db.collection("usage_tracking").stream()
    results = []
    for doc in docs:
        d = doc.to_dict()
        results.append({
            "email": d.get("email", ""),
            "display_name": d.get("display_name", ""),
            "total_images": d.get("total_images", 0),
            "total_videos": d.get("total_videos", 0),
            "total_scripts": d.get("total_scripts", 0),
            "total_storyboards": d.get("total_storyboards", 0),
            "total_session_seconds": d.get("total_session_seconds", 0),
            "last_active_at": _ts_to_iso(d.get("last_active_at")),
            "first_seen_at": _ts_to_iso(d.get("first_seen_at")),
        })
    # Sort by last_active_at desc
    results.sort(key=lambda r: r.get("last_active_at") or "", reverse=True)
    return results


def _get_user_daily_sync(email: str, days: int = 30) -> list[dict]:
    """Read daily breakdown for a specific user."""
    db = _get_db()
    if db is None:
        return []

    key = _email_key(email)
    daily_ref = (
        db.collection("usage_tracking")
        .document(key)
        .collection("daily")
        .order_by("__name__", direction="DESCENDING")
        .limit(days)
    )
    results = []
    for doc in daily_ref.stream():
        d = doc.to_dict()
        results.append({
            "date": doc.id,
            "images": d.get("images", 0),
            "videos": d.get("videos", 0),
            "scripts": d.get("scripts", 0),
            "storyboards": d.get("storyboards", 0),
            "active_seconds": d.get("active_seconds", 0),
        })
    results.sort(key=lambda r: r["date"])
    return results


def _ts_to_iso(val: Any) -> Optional[str]:
    """Convert a Firestore timestamp to ISO string."""
    if val is None:
        return None
    try:
        if hasattr(val, "isoformat"):
            return val.isoformat()
        return str(val)
    except Exception:
        return None


# ── Async public API (used by routers) ────────────────────────────────

async def track_event(
    email: str,
    event_type: str,
    count: int = 1,
    display_name: str = "",
) -> None:
    """Fire-and-forget event tracking.  Never raises."""
    if not is_enabled() or not email:
        return
    try:
        await asyncio.to_thread(
            _track_event_sync, email, event_type, count, display_name,
        )
    except Exception as e:
        log.debug("tracking: track_event failed: %s", e)


async def heartbeat(email: str, display_name: str = "") -> None:
    """Record a session heartbeat.  Never raises."""
    if not is_enabled() or not email:
        return
    try:
        await asyncio.to_thread(_heartbeat_sync, email, display_name)
    except Exception as e:
        log.debug("tracking: heartbeat failed: %s", e)


async def get_all_stats() -> list[dict]:
    """All users' aggregated stats (for admin dashboard)."""
    if not is_enabled():
        return []
    try:
        return await asyncio.to_thread(_get_all_stats_sync)
    except Exception as e:
        log.warning("tracking: get_all_stats failed: %s", e)
        return []


async def get_user_daily(email: str, days: int = 30) -> list[dict]:
    """Daily breakdown for a user."""
    if not is_enabled():
        return []
    try:
        return await asyncio.to_thread(_get_user_daily_sync, email, days)
    except Exception as e:
        log.warning("tracking: get_user_daily failed: %s", e)
        return []


# ── Role Management ──────────────────────────────────────────────────
# Firestore collection: tracking_roles/{email_key}
#   { email, role, added_at, added_by }

VALID_ROLES = ("admin", "design", "seo")
_ROLES_COLLECTION = "tracking_roles"


def _list_roles_sync() -> list[dict]:
    db = _get_db()
    if not db:
        return []
    docs = db.collection(_ROLES_COLLECTION).stream()
    result = []
    for doc in docs:
        d = doc.to_dict()
        d["id"] = doc.id
        result.append(d)
    return sorted(result, key=lambda x: x.get("email", ""))


def _get_role_sync(email: str) -> Optional[dict]:
    db = _get_db()
    if not db:
        return None
    doc = db.collection(_ROLES_COLLECTION).document(_email_key(email)).get()
    if doc.exists:
        d = doc.to_dict()
        d["id"] = doc.id
        return d
    return None


def _set_role_sync(email: str, role: str, added_by: str = "") -> dict:
    from firebase_admin import firestore as _fs  # type: ignore
    db = _get_db()
    if not db:
        return {}
    key = _email_key(email)
    now = _fs.SERVER_TIMESTAMP
    data = {
        "email": email.lower().strip(),
        "role": role,
        "added_by": added_by,
        "updated_at": now,
    }
    # Only set added_at on creation
    existing = db.collection(_ROLES_COLLECTION).document(key).get()
    if not existing.exists:
        data["added_at"] = now
    db.collection(_ROLES_COLLECTION).document(key).set(data, merge=True)
    return {"email": email.lower().strip(), "role": role}


def _delete_role_sync(email: str) -> bool:
    db = _get_db()
    if not db:
        return False
    key = _email_key(email)
    doc = db.collection(_ROLES_COLLECTION).document(key).get()
    if doc.exists:
        db.collection(_ROLES_COLLECTION).document(key).delete()
        return True
    return False


async def list_roles() -> list[dict]:
    """List all user roles."""
    if not is_enabled():
        return []
    try:
        return await asyncio.to_thread(_list_roles_sync)
    except Exception as e:
        log.warning("tracking: list_roles failed: %s", e)
        return []


async def get_role(email: str) -> Optional[dict]:
    """Get a specific user's role."""
    if not is_enabled():
        return None
    try:
        return await asyncio.to_thread(_get_role_sync, email)
    except Exception as e:
        log.warning("tracking: get_role failed: %s", e)
        return None


async def set_role(email: str, role: str, added_by: str = "") -> dict:
    """Set a user's role. Creates the entry if it doesn't exist."""
    if not is_enabled():
        return {}
    try:
        return await asyncio.to_thread(_set_role_sync, email, role, added_by)
    except Exception as e:
        log.warning("tracking: set_role failed: %s", e)
        return {}


async def delete_role(email: str) -> bool:
    """Remove a user's role entry."""
    if not is_enabled():
        return False
    try:
        return await asyncio.to_thread(_delete_role_sync, email)
    except Exception as e:
        log.warning("tracking: delete_role failed: %s", e)
        return False


async def is_firestore_admin(email: str) -> bool:
    """Check if an email has admin role in Firestore."""
    if not is_enabled() or not email:
        return False
    try:
        r = await get_role(email.lower().strip())
        return r is not None and r.get("role") == "admin"
    except Exception:
        return False
