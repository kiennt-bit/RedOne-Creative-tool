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
    ├─ total_images, total_videos, total_scripts, total_storyboards, total_upscaled_videos
    ├─ total_session_seconds, last_upscale
    └─ daily/{YYYY-MM-DD}            — per-day detail subcollection
         ├─ images, videos, scripts, storyboards, upscaled_videos
         ├─ active_seconds
         └─ last_heartbeat
"""
from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any, Optional

from ..config import (
    DATA_DIR,
    FIREBASE_PROJECT_ID,
    FIREBASE_TRACKING_ENABLED,
    FIREBASE_HEARTBEAT_INTERVAL_S,
    TRACKING_ADMIN_EMAILS,
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

_STATS_FILE = DATA_DIR / "tracking_stats.json"
_stats_lock = threading.Lock()


def _load_local_stats() -> dict[str, Any]:
    """Load local usage tracking data (offline / quota-free)."""
    with _stats_lock:
        if _STATS_FILE.is_file():
            try:
                with open(_STATS_FILE, "r", encoding="utf-8") as f:
                    content = f.read().strip()
                    if content:
                        return json.loads(content)
            except Exception as e:
                log.warning("tracking: failed reading tracking_stats.json: %s", e)
        return {"users": {}, "daily": {}}


def _save_local_stats(data: dict[str, Any]) -> None:
    """Save local usage tracking data atomically."""
    with _stats_lock:
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            tmp = _STATS_FILE.with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            tmp.replace(_STATS_FILE)
        except Exception as e:
            log.warning("tracking: failed writing tracking_stats.json: %s", e)


def _track_event_sync(
    email: str,
    event_type: str,
    count: int = 1,
    display_name: str = "",
    extra: Optional[dict] = None,
) -> None:
    """Write a tracking event to local storage (instant) and Firestore (best-effort bg).

    ``event_type`` must be one of:
      ``image_created``, ``video_created``, ``script_created``,
      ``storyboard_created``, ``video_upscaled``
    """
    clean_email = (email or "").lower().strip()
    if not clean_email:
        return

    field_map = {
        "image_created": "images",
        "video_created": "videos",
        "script_created": "scripts",
        "storyboard_created": "storyboards",
        "video_upscaled": "upscaled_videos",
    }
    field = field_map.get(event_type)
    if not field:
        log.warning("tracking: unknown event_type=%s", event_type)
        return

    now_iso = datetime.now(timezone.utc).isoformat()
    today_str = _today()

    # 1. Update local tracking_stats.json (Instant, reliable, quota-free)
    stats = _load_local_stats()
    users = stats.setdefault("users", {})
    daily = stats.setdefault("daily", {})

    u = users.setdefault(clean_email, {
        "email": clean_email,
        "display_name": display_name or clean_email.split("@")[0],
        "total_images": 0,
        "total_videos": 0,
        "total_scripts": 0,
        "total_storyboards": 0,
        "total_upscaled_videos": 0,
        "total_upscaled_topaz": 0,
        "total_upscaled_realesrgan": 0,
        "last_upscale": None,
        "total_session_seconds": 0,
        "last_active_at": now_iso,
        "first_seen_at": now_iso,
    })
    u["total_" + field] = (u.get("total_" + field, 0) or 0) + count
    u["last_active_at"] = now_iso
    if display_name:
        u["display_name"] = display_name

    u_daily = daily.setdefault(clean_email, {})
    d_entry = u_daily.setdefault(today_str, {
        "date": today_str,
        "images": 0,
        "videos": 0,
        "scripts": 0,
        "storyboards": 0,
        "upscaled_videos": 0,
        "upscaled_topaz": 0,
        "upscaled_realesrgan": 0,
        "active_seconds": 0,
    })
    d_entry[field] = (d_entry.get(field, 0) or 0) + count

    if extra and isinstance(extra, dict) and event_type == "video_upscaled":
        model_name = str(extra.get("model", "") or "")
        res_val = str(extra.get("resolution", "") or "")
        v_name = str(extra.get("video_name", "") or "")
        last_up = {
            "model": model_name,
            "resolution": res_val,
            "video_name": v_name,
            "at": now_iso,
        }
        u["last_upscale"] = last_up
        if "topaz" in model_name.lower() or "proteus" in model_name.lower():
            u["total_upscaled_topaz"] = (u.get("total_upscaled_topaz", 0) or 0) + count
            d_entry["upscaled_topaz"] = (d_entry.get("upscaled_topaz", 0) or 0) + count
        else:
            u["total_upscaled_realesrgan"] = (u.get("total_upscaled_realesrgan", 0) or 0) + count
            d_entry["upscaled_realesrgan"] = (d_entry.get("upscaled_realesrgan", 0) or 0) + count

    _save_local_stats(stats)
    log.info("tracking: recorded event %s for %s locally (count=%d)", event_type, clean_email, count)

    # 2. Best-effort background sync to Firestore
    def _sync_fs():
        try:
            db = _get_db()
            if not db:
                return
            from firebase_admin import firestore as _fs  # type: ignore
            key = _email_key(clean_email)
            now_dt = datetime.now(timezone.utc)
            user_ref = db.collection("usage_tracking").document(key)
            daily_ref = user_ref.collection("daily").document(today_str)

            fs_user = {
                "email": clean_email,
                "display_name": display_name or clean_email.split("@")[0],
                f"total_{field}": _fs.Increment(count),
                "last_active_at": now_dt,
            }
            fs_daily = {
                field: _fs.Increment(count),
                "last_heartbeat": now_dt,
            }
            if extra and isinstance(extra, dict) and event_type == "video_upscaled":
                m_name = str(extra.get("model", "") or "")
                fs_user["last_upscale"] = {
                    "model": m_name,
                    "resolution": str(extra.get("resolution", "") or ""),
                    "video_name": str(extra.get("video_name", "") or ""),
                    "at": now_dt,
                }
                if "topaz" in m_name.lower() or "proteus" in m_name.lower():
                    fs_user["total_upscaled_topaz"] = _fs.Increment(count)
                    fs_daily["upscaled_topaz"] = _fs.Increment(count)
                else:
                    fs_user["total_upscaled_realesrgan"] = _fs.Increment(count)
                    fs_daily["upscaled_realesrgan"] = _fs.Increment(count)

            user_ref.set(fs_user, merge=True, retry=None, timeout=5.0)
            daily_ref.set(fs_daily, merge=True, retry=None, timeout=5.0)
        except Exception as e:
            log.debug("tracking: Firestore sync for track_event failed: %s", e)

    threading.Thread(target=_sync_fs, daemon=True).start()


def _heartbeat_sync(email: str, display_name: str = "") -> None:
    """Record a session heartbeat (local instant + Firestore bg)."""
    clean_email = (email or "").lower().strip()
    if not clean_email:
        return
    now_iso = datetime.now(timezone.utc).isoformat()
    today_str = _today()
    interval = FIREBASE_HEARTBEAT_INTERVAL_S

    stats = _load_local_stats()
    users = stats.setdefault("users", {})
    daily = stats.setdefault("daily", {})

    u = users.setdefault(clean_email, {
        "email": clean_email,
        "display_name": display_name or clean_email.split("@")[0],
        "total_images": 0,
        "total_videos": 0,
        "total_scripts": 0,
        "total_storyboards": 0,
        "total_upscaled_videos": 0,
        "total_upscaled_topaz": 0,
        "total_upscaled_realesrgan": 0,
        "last_upscale": None,
        "total_session_seconds": 0,
        "last_active_at": now_iso,
        "first_seen_at": now_iso,
    })
    u["total_session_seconds"] = (u.get("total_session_seconds", 0) or 0) + interval
    u["last_active_at"] = now_iso

    u_daily = daily.setdefault(clean_email, {})
    d_entry = u_daily.setdefault(today_str, {
        "date": today_str,
        "images": 0,
        "videos": 0,
        "scripts": 0,
        "storyboards": 0,
        "upscaled_videos": 0,
        "upscaled_topaz": 0,
        "upscaled_realesrgan": 0,
        "active_seconds": 0,
    })
    d_entry["active_seconds"] = (d_entry.get("active_seconds", 0) or 0) + interval
    _save_local_stats(stats)

    # Best-effort background sync
    def _sync_hb():
        try:
            db = _get_db()
            if not db:
                return
            from firebase_admin import firestore as _fs  # type: ignore
            key = _email_key(clean_email)
            now_dt = datetime.now(timezone.utc)
            user_ref = db.collection("usage_tracking").document(key)
            daily_ref = user_ref.collection("daily").document(today_str)
            user_ref.set({
                "email": clean_email,
                "display_name": display_name or clean_email.split("@")[0],
                "total_session_seconds": _fs.Increment(interval),
                "last_active_at": now_dt,
            }, merge=True, retry=None, timeout=5.0)
            daily_ref.set({
                "active_seconds": _fs.Increment(interval),
                "last_heartbeat": now_dt,
            }, merge=True, retry=None, timeout=5.0)
        except Exception as e:
            log.debug("tracking: Firestore sync for heartbeat failed: %s", e)

    threading.Thread(target=_sync_hb, daemon=True).start()


def _get_all_stats_sync() -> list[dict]:
    """Read aggregated stats for ALL users (admin dashboard), merging Firestore and local data."""
    roles_map = _load_local_roles()
    local_stats = _load_local_stats()
    local_users = local_stats.get("users", {})

    merged: dict[str, dict] = {}

    # 1. First populate from Firestore if available
    db = _get_db()
    if db is not None:
        try:
            docs = db.collection("usage_tracking").stream(timeout=3.0)
            for doc in docs:
                d = doc.to_dict() or {}
                last_up = d.get("last_upscale")
                if isinstance(last_up, dict):
                    last_up = dict(last_up)
                    last_up["at"] = _ts_to_iso(last_up.get("at"))

                em = (d.get("email") or "").lower().strip()
                if not em:
                    continue
                merged[em] = {
                    "email": em,
                    "display_name": d.get("display_name", "") or em.split("@")[0],
                    "total_images": d.get("total_images", 0) or 0,
                    "total_videos": d.get("total_videos", 0) or 0,
                    "total_scripts": d.get("total_scripts", 0) or 0,
                    "total_storyboards": d.get("total_storyboards", 0) or 0,
                    "total_upscaled_videos": d.get("total_upscaled_videos", 0) or 0,
                    "total_upscaled_topaz": d.get("total_upscaled_topaz", 0) or 0,
                    "total_upscaled_realesrgan": d.get("total_upscaled_realesrgan", 0) or 0,
                    "last_upscale": last_up,
                    "total_session_seconds": d.get("total_session_seconds", 0) or 0,
                    "last_active_at": _ts_to_iso(d.get("last_active_at")),
                    "first_seen_at": _ts_to_iso(d.get("first_seen_at")),
                }
        except Exception as e:
            log.warning("tracking: get_all_stats Firestore stream failed: %s", e)

    # 2. Merge local stats (take max of counters and local overrides)
    for em, lu in local_users.items():
        em_clean = em.lower().strip()
        if em_clean not in merged:
            merged[em_clean] = dict(lu)
        else:
            rec = merged[em_clean]
            for f in [
                "total_images", "total_videos", "total_scripts", "total_storyboards",
                "total_upscaled_videos", "total_upscaled_topaz", "total_upscaled_realesrgan",
                "total_session_seconds",
            ]:
                rec[f] = max(rec.get(f, 0) or 0, lu.get(f, 0) or 0)
            if lu.get("last_upscale"):
                rec["last_upscale"] = lu["last_upscale"]
            if lu.get("last_active_at"):
                rec["last_active_at"] = lu["last_active_at"]

    # 3. Include registered roles that have no usage yet
    for email, rinfo in roles_map.items():
        if email not in merged:
            merged[email] = {
                "email": email,
                "display_name": email.split("@")[0],
                "total_images": 0,
                "total_videos": 0,
                "total_scripts": 0,
                "total_storyboards": 0,
                "total_upscaled_videos": 0,
                "total_upscaled_topaz": 0,
                "total_upscaled_realesrgan": 0,
                "last_upscale": None,
                "total_session_seconds": 0,
                "last_active_at": None,
                "first_seen_at": rinfo.get("added_at"),
            }

    # 4. Attach role to all records
    results = []
    for em, rec in merged.items():
        role = "design"
        if em in roles_map:
            role = roles_map[em].get("role", "design")
        elif em in TRACKING_ADMIN_EMAILS:
            role = "admin"
        rec["role"] = role
        results.append(rec)

    # Sort: first by last_active_at desc, then by total_session_seconds desc
    results.sort(key=lambda r: (r.get("last_active_at") or "", r.get("total_session_seconds", 0)), reverse=True)
    return results


def _get_user_daily_sync(email: str, days: int = 30) -> list[dict]:
    """Read daily breakdown for a specific user, merging Firestore and local data."""
    clean_email = email.lower().strip()
    daily_map: dict[str, dict] = {}

    # 1. Read Firestore if available
    db = _get_db()
    if db is not None:
        try:
            key = _email_key(clean_email)
            daily_ref = (
                db.collection("usage_tracking")
                .document(key)
                .collection("daily")
                .order_by("__name__", direction="DESCENDING")
                .limit(days)
            )
            for doc in daily_ref.stream(timeout=3.0):
                d = doc.to_dict() or {}
                daily_map[doc.id] = {
                    "date": doc.id,
                    "images": d.get("images", 0) or 0,
                    "videos": d.get("videos", 0) or 0,
                    "scripts": d.get("scripts", 0) or 0,
                    "storyboards": d.get("storyboards", 0) or 0,
                    "upscaled_videos": d.get("upscaled_videos", 0) or 0,
                    "upscaled_topaz": d.get("upscaled_topaz", 0) or 0,
                    "upscaled_realesrgan": d.get("upscaled_realesrgan", 0) or 0,
                    "active_seconds": d.get("active_seconds", 0) or 0,
                }
        except Exception as e:
            log.debug("tracking: Firestore daily read failed: %s", e)

    # 2. Merge local daily stats
    local_stats = _load_local_stats()
    local_daily = local_stats.get("daily", {}).get(clean_email, {})
    for date_str, ld in local_daily.items():
        if date_str not in daily_map:
            daily_map[date_str] = dict(ld)
        else:
            entry = daily_map[date_str]
            for k in ["images", "videos", "scripts", "storyboards", "upscaled_videos", "upscaled_topaz", "upscaled_realesrgan", "active_seconds"]:
                entry[k] = max(entry.get(k, 0) or 0, ld.get(k, 0) or 0)

    results = list(daily_map.values())
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
    extra: Optional[dict] = None,
) -> None:
    """Fire-and-forget event tracking.  Never raises."""
    if not is_enabled() or not email:
        return
    try:
        await asyncio.to_thread(
            _track_event_sync, email, event_type, count, display_name, extra,
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
# Dual storage:
#   1. Local persistent storage: data/tracking_roles.json (instant read/write, quota-free)
#   2. Cloud Firestore: tracking_roles/{email_key} (best-effort background sync)

VALID_ROLES = ("admin", "design", "seo")
_ROLES_COLLECTION = "tracking_roles"
_ROLES_FILE = DATA_DIR / "tracking_roles.json"
_roles_lock = threading.Lock()


def _load_local_roles() -> dict[str, dict]:
    """Load roles dictionary from local JSON file.

    Returns dict mapping lowercase email -> role info dict:
      {
        "email": str,
        "role": "admin" | "seo" | "design",
        "added_by": str,
        "added_at": str (ISO),
        "updated_at": str (ISO)
      }
    Always ensures bootstrap admins from config.py exist with 'admin' role.
    """
    with _roles_lock:
        data: dict[str, dict] = {}
        if _ROLES_FILE.is_file():
            try:
                with open(_ROLES_FILE, "r", encoding="utf-8") as f:
                    raw = f.read().strip()
                    if raw:
                        data = json.loads(raw)
            except Exception as e:
                log.warning("tracking: failed reading tracking_roles.json: %s", e)
                data = {}

        # Ensure bootstrap admin emails are present
        now_iso = datetime.now(timezone.utc).isoformat()
        for admin_email in TRACKING_ADMIN_EMAILS:
            clean = admin_email.lower().strip()
            if not clean:
                continue
            if clean not in data:
                data[clean] = {
                    "email": clean,
                    "role": "admin",
                    "added_by": "system (config.py)",
                    "added_at": now_iso,
                    "updated_at": now_iso,
                }
        return data


def _save_local_roles(roles_dict: dict[str, dict]) -> None:
    """Save roles dictionary to local JSON file safely using atomic replace."""
    with _roles_lock:
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            tmp_file = _ROLES_FILE.with_suffix(".tmp")
            with open(tmp_file, "w", encoding="utf-8") as f:
                json.dump(roles_dict, f, ensure_ascii=False, indent=2)
            tmp_file.replace(_ROLES_FILE)
        except Exception as e:
            log.warning("tracking: failed writing tracking_roles.json: %s", e)


def _sync_role_to_firestore_bg(email: str, role: str, added_by: str, added_at: str, updated_at: str) -> None:
    """Background best-effort sync to Firestore with a strict 3s timeout."""
    try:
        db = _get_db()
        if not db:
            return
        key = _email_key(email)
        db.collection(_ROLES_COLLECTION).document(key).set({
            "email": email,
            "role": role,
            "added_by": added_by,
            "added_at": added_at,
            "updated_at": updated_at,
        }, merge=True, timeout=3.0)
        log.info("tracking: synced role for %s (%s) to Firestore", email, role)
    except Exception as e:
        log.debug("tracking: best-effort Firestore sync for set_role(%s) failed: %s", email, e)


def _delete_role_from_firestore_bg(email: str) -> None:
    """Background best-effort delete from Firestore with a strict 3s timeout."""
    try:
        db = _get_db()
        if not db:
            return
        key = _email_key(email)
        db.collection(_ROLES_COLLECTION).document(key).delete(timeout=3.0)
        log.info("tracking: deleted role for %s from Firestore", email)
    except Exception as e:
        log.debug("tracking: best-effort Firestore sync for delete_role(%s) failed: %s", email, e)


def _list_roles_sync() -> list[dict]:
    roles_map = _load_local_roles()

    # Best-effort sync from Firestore to discover roles created on other instances
    if is_enabled():
        try:
            db = _get_db()
            if db:
                docs = db.collection(_ROLES_COLLECTION).stream(timeout=2.0)
                dirty = False
                for doc in docs:
                    d = doc.to_dict() or {}
                    em = (d.get("email") or doc.id.replace(",", ".")).lower().strip()
                    if em:
                        if em not in roles_map or roles_map[em].get("role") != d.get("role"):
                            roles_map[em] = {
                                "email": em,
                                "role": d.get("role", "design"),
                                "added_by": d.get("added_by", ""),
                                "added_at": _ts_to_iso(d.get("added_at")) or datetime.now(timezone.utc).isoformat(),
                                "updated_at": _ts_to_iso(d.get("updated_at")) or datetime.now(timezone.utc).isoformat(),
                            }
                            dirty = True
                if dirty:
                    _save_local_roles(roles_map)
        except Exception as e:
            log.debug("tracking: Firestore stream in _list_roles_sync skipped: %s", e)

    result = list(roles_map.values())
    return sorted(result, key=lambda x: (x.get("role", ""), x.get("email", "")))


def _get_role_sync(email: str) -> Optional[dict]:
    clean = email.lower().strip()
    if not clean:
        return None
    roles_map = _load_local_roles()
    if clean in roles_map:
        return roles_map[clean]
    if clean in TRACKING_ADMIN_EMAILS:
        return {"email": clean, "role": "admin", "added_by": "system"}

    # Fallback to Firestore if not found locally
    if is_enabled():
        try:
            db = _get_db()
            if db:
                doc = db.collection(_ROLES_COLLECTION).document(_email_key(clean)).get(timeout=2.0)
                if doc.exists:
                    d = doc.to_dict() or {}
                    d["email"] = clean
                    roles_map[clean] = d
                    _save_local_roles(roles_map)
                    return d
        except Exception as e:
            log.debug("tracking: Firestore get_role failed for %s: %s", clean, e)
    return None


def _set_role_sync(email: str, role: str, added_by: str = "") -> dict:
    clean = email.lower().strip()
    roles_map = _load_local_roles()
    now_iso = datetime.now(timezone.utc).isoformat()
    existing = roles_map.get(clean)
    added_at = existing.get("added_at") if existing else now_iso

    entry = {
        "email": clean,
        "role": role,
        "added_by": added_by or (existing.get("added_by") if existing else ""),
        "added_at": added_at,
        "updated_at": now_iso,
    }
    roles_map[clean] = entry
    _save_local_roles(roles_map)

    # Launch background best-effort sync to Firestore
    if is_enabled():
        threading.Thread(
            target=_sync_role_to_firestore_bg,
            args=(clean, role, entry["added_by"], added_at, now_iso),
            daemon=True,
        ).start()

    return {"email": clean, "role": role, "added_by": entry["added_by"]}


def _delete_role_sync(email: str) -> bool:
    clean = email.lower().strip()
    roles_map = _load_local_roles()
    if clean not in roles_map:
        return False

    del roles_map[clean]
    _save_local_roles(roles_map)

    # Launch background best-effort sync to Firestore
    if is_enabled():
        threading.Thread(
            target=_delete_role_from_firestore_bg,
            args=(clean,),
            daemon=True,
        ).start()

    return True


async def list_roles() -> list[dict]:
    """List all user roles."""
    return await asyncio.to_thread(_list_roles_sync)


async def get_role(email: str) -> Optional[dict]:
    """Get a specific user's role."""
    return await asyncio.to_thread(_get_role_sync, email)


async def set_role(email: str, role: str, added_by: str = "") -> dict:
    """Set a user's role. Creates the entry if it doesn't exist."""
    return await asyncio.to_thread(_set_role_sync, email, role, added_by)


async def delete_role(email: str) -> bool:
    """Remove a user's role entry."""
    return await asyncio.to_thread(_delete_role_sync, email)


async def is_firestore_admin(email: str) -> bool:
    """Check if an email has admin role in Firestore."""
    if not is_enabled() or not email:
        return False
    try:
        r = await get_role(email.lower().strip())
        return r is not None and r.get("role") == "admin"
    except Exception:
        return False
