"""Client for the RedOne Hub (multi-user management server).

BEST-EFFORT + GRACEFUL: if the Hub is not configured (config.HUB_BASE_URL
empty) or unreachable, every call degrades to a safe no-op so the tool keeps
working exactly like the single-user version. Quota is only enforced while
the Hub is reachable (offline → allow gen, per the multi-user plan).

Identity bootstrap: the OAuth callback passes the fresh Google id_token to
verify_and_store(), which exchanges it for a long-lived Hub token cached in
data/hub_session.json. All later calls authenticate with that Hub token.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime
from typing import Optional

import httpx

from ..config import HUB_BASE_URL, HUB_SESSION_FILE, HUB_TIMEOUT_S

log = logging.getLogger("redone.hub")


def is_enabled() -> bool:
    return bool(HUB_BASE_URL)


# ── Local Hub-session cache (data/hub_session.json) ────────────────────
def _load() -> Optional[dict]:
    try:
        if HUB_SESSION_FILE.exists():
            rec = json.loads(HUB_SESSION_FILE.read_text(encoding="utf-8"))
            if isinstance(rec, dict) and rec.get("token") and rec.get("expires_at", 0) > time.time():
                return rec
    except Exception as e:
        log.debug("hub: load session failed: %s", e)
    return None


def _save(rec: dict) -> None:
    try:
        HUB_SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
        HUB_SESSION_FILE.write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        log.warning("hub: save session failed: %s", e)


def clear() -> None:
    try:
        if HUB_SESSION_FILE.exists():
            HUB_SESSION_FILE.unlink()
    except Exception:
        pass


def load_session() -> Optional[dict]:
    """Cached Hub identity {token,email,role,team_id,expires_at} or None."""
    return _load()


def _auth_headers() -> Optional[dict]:
    rec = _load()
    return {"Authorization": f"Bearer {rec['token']}"} if rec else None


def _to_epoch(iso: str) -> float:
    try:
        return datetime.fromisoformat((iso or "").replace("Z", "+00:00")).timestamp()
    except Exception:
        return time.time() + 25 * 86400  # ~25d fallback


# ── Identity ───────────────────────────────────────────────────────────
async def verify_and_store(id_token: str) -> Optional[dict]:
    """Exchange a fresh Google id_token for a Hub session. Best-effort."""
    if not is_enabled() or not id_token:
        return None
    try:
        async with httpx.AsyncClient(timeout=HUB_TIMEOUT_S) as c:
            r = await c.post(f"{HUB_BASE_URL}/auth/verify", json={"id_token": id_token})
        if r.status_code != 200:
            log.warning("hub: /auth/verify -> %s %s", r.status_code, r.text[:200])
            return None
        d = r.json()
        rec = {
            "token": d.get("token"),
            "email": d.get("email"),
            "name": d.get("name"),
            "role": d.get("role"),
            "team_id": d.get("team_id"),
            "expires_at": _to_epoch(d.get("expires_at", "")),
        }
        _save(rec)
        log.info("hub: linked %s as %s", rec.get("email"), rec.get("role"))
        return rec
    except Exception as e:
        log.warning("hub: verify failed (offline?): %s", e)
        return None


async def get_me() -> Optional[dict]:
    """Live role/team/quota from the Hub, or None if disabled/unreachable."""
    if not is_enabled():
        return None
    h = _auth_headers()
    if not h:
        return None
    try:
        async with httpx.AsyncClient(timeout=HUB_TIMEOUT_S) as c:
            r = await c.get(f"{HUB_BASE_URL}/me", headers=h)
        if r.status_code == 200:
            return r.json()
        if r.status_code == 401:
            clear()  # token expired → next login re-links
    except Exception as e:
        log.debug("hub: /me failed: %s", e)
    return None


async def api_request(method: str, path: str, params: Optional[dict] = None,
                      json: Optional[dict] = None) -> tuple[int, Optional[object]]:
    """Generic authenticated proxy to the Hub. Returns (status_code, data|None).
    (0, None) = Hub disabled / not linked / unreachable. Used by the local
    /api/hub/* proxy router so the tool frontend can reach the Hub."""
    if not is_enabled():
        return (0, None)
    h = _auth_headers()
    if not h:
        return (0, None)
    try:
        async with httpx.AsyncClient(timeout=HUB_TIMEOUT_S) as c:
            r = await c.request(method, f"{HUB_BASE_URL}{path}", headers=h, params=params, json=json)
        data: Optional[object] = None
        try:
            data = r.json()
        except Exception:
            data = None
        if r.status_code == 401:
            clear()
        return (r.status_code, data)
    except Exception as e:
        log.debug("hub: api_request %s %s failed: %s", method, path, e)
        return (0, None)


# ── Credit lifecycle ───────────────────────────────────────────────────
async def reserve(kind: str, model: str = "", credit_cost: int = 1, prompt: str = "") -> dict:
    """Reserve credit before a gen. Returns one of:
      {ok:True,  reservation_id, remaining}          → reserved, proceed
      {ok:False, message, remaining}                 → out of credit, BLOCK gen
      {ok:True,  reservation_id:None, offline:True}  → hub off/unreachable, allow
    """
    offline = {"ok": True, "reservation_id": None, "offline": True}
    if not is_enabled():
        return offline
    h = _auth_headers()
    if not h:
        return offline
    try:
        async with httpx.AsyncClient(timeout=HUB_TIMEOUT_S) as c:
            r = await c.post(
                f"{HUB_BASE_URL}/events/reserve",
                headers=h,
                json={"type": kind, "model": model, "credit_cost": int(credit_cost), "prompt": prompt[:2000]},
            )
        if r.status_code == 200:
            return r.json()
        if r.status_code == 401:
            clear()
    except Exception as e:
        log.debug("hub: reserve failed: %s", e)
    return offline


async def commit(
    reservation_id: Optional[int],
    status: str = "done",
    kind: str = "",
    model: str = "",
    credit_cost: int = 1,
    prompt: str = "",
    thumb: Optional[tuple] = None,
) -> Optional[dict]:
    """Report a finished gen (+ optional thumbnail) to the Hub. Best-effort.
    `thumb` = (filename, bytes, content_type)."""
    if not is_enabled():
        return None
    h = _auth_headers()
    if not h:
        return None
    data = {
        "status": status,
        "type": kind,
        "model": model,
        "credit_cost": str(int(credit_cost)),
        "prompt": prompt[:2000],
    }
    if reservation_id:
        data["reservation_id"] = str(reservation_id)
    files = {"thumb": thumb} if thumb else None
    try:
        async with httpx.AsyncClient(timeout=HUB_TIMEOUT_S * 4) as c:
            r = await c.post(f"{HUB_BASE_URL}/events/commit", headers=h, data=data, files=files)
        if r.status_code == 200:
            return r.json()
        if r.status_code == 401:
            clear()
    except Exception as e:
        log.debug("hub: commit failed: %s", e)
    return None


# ── Thumbnail helper (CPU-bound; call via executor inside async gen) ────
def make_image_thumbnail(path, max_side: int = 640) -> Optional[tuple]:
    """Build a small JPEG thumbnail from an image file → (name, bytes, ctype)."""
    try:
        import io

        from PIL import Image

        with Image.open(path) as im:
            im = im.convert("RGB")
            im.thumbnail((max_side, max_side))
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=80)
            return ("thumb.jpg", buf.getvalue(), "image/jpeg")
    except Exception as e:
        log.debug("hub: thumbnail failed: %s", e)
        return None


def current_user_email() -> Optional[str]:
    """Email of the user logged into the tool on this machine — used to stamp
    local task rows. (The Hub itself identifies the user by the Hub token.)"""
    try:
        from .oauth_auth import load_session
        s = load_session()
        return s.get("email") if s else None
    except Exception:
        return None


async def _build_thumb(path: str, is_video: bool) -> Optional[tuple]:
    """(name, bytes, ctype) JPEG thumbnail from an image file, or from a video
    by extracting one frame first. Best-effort → None on any failure."""
    import asyncio
    loop = asyncio.get_running_loop()
    if not is_video:
        return await loop.run_in_executor(None, make_image_thumbnail, path)
    import os
    import tempfile
    tmp = os.path.join(tempfile.gettempdir(), f"hubthumb_{os.getpid()}_{int(time.time() * 1000)}.jpg")
    try:
        from .ffmpeg_utils import extract_thumbnail
        ok = await extract_thumbnail(path, tmp, at=0.5)
        if not ok:
            return None
        return await loop.run_in_executor(None, make_image_thumbnail, tmp)
    except Exception as e:
        log.debug("hub: video thumb failed: %s", e)
        return None
    finally:
        try:
            os.remove(tmp)
        except Exception:
            pass


async def commit_result(reservation_id, status: str, *, kind: str, model: str,
                        credit_cost: int, prompt: str, path: Optional[str] = None,
                        is_video: bool = False) -> None:
    """High-level helper for gen routers: build a thumbnail (on success) and
    commit the result to the Hub. Best-effort — never raises, never blocks gen."""
    if not is_enabled():
        return
    thumb = None
    if status == "done" and path:
        try:
            thumb = await _build_thumb(path, is_video)
        except Exception:
            thumb = None
    try:
        await commit(reservation_id=reservation_id, status=status, kind=kind,
                     model=model, credit_cost=credit_cost, prompt=prompt, thumb=thumb)
    except Exception as e:
        log.debug("hub: commit_result failed: %s", e)


# ── Shared-account credentials (team) ──────────────────────────────────
async def get_shared_credentials() -> Optional[dict]:
    """This member's team shared account (DECRYPTED) from the Hub, or None.

    Shape: {google_email, google_password, shakker_token, shakker_webid,
    has_google, has_shakker}. For auto-login only — NEVER displayed in any UI.
    """
    if not is_enabled():
        return None
    st, data = await api_request("GET", "/me/team-credentials")
    if st == 200 and isinstance(data, dict):
        return data
    return None


async def sync_shared_credentials() -> Optional[dict]:
    """On login: pull the team's shared account. If a Shakker token is present,
    write it into the local `shakker_accounts` so this member gens with the
    shared Shakker account WITHOUT ever opening shakker.ai (token is
    self-sufficient). Returns the creds dict (the Google email/password are
    consumed later by the extension auto-fill, not persisted on disk here).
    Best-effort — never raises."""
    if not is_enabled():
        return None
    try:
        creds = await get_shared_credentials()
    except Exception as e:
        log.debug("hub: get_shared_credentials failed: %s", e)
        return None
    if not creds:
        return None
    token = (creds.get("shakker_token") or "").strip()
    if token:
        try:
            from ..database import db
            db.upsert_shakker_account(
                "team-shared",
                token=token,
                email=(creds.get("google_email") or "team-shared"),
                webid=(creds.get("shakker_webid") or None),
                status="OK",
                status_msg="shared via Hub",
            )
            log.info("hub: synced shared Shakker token into local account")
        except Exception as e:
            log.warning("hub: shakker token sync failed: %s", e)
    return creds


_last_pushed_shakker_token: Optional[str] = None


async def maybe_push_shared_shakker_token(token: str) -> None:
    """Auto-share: when THIS machine's Hub user is admin/lead, push a freshly
    captured Shakker token to the Hub as the team's shared token, so members
    receive it on their next login — the lead does NOTHING beyond logging into
    shakker.ai. Throttled to token changes; best-effort (never raises)."""
    global _last_pushed_shakker_token
    if not is_enabled():
        return
    token = (token or "").strip()
    if not token or token == _last_pushed_shakker_token:
        return
    sess = load_session() or {}
    if (sess.get("role") or "").lower() not in ("admin", "lead"):
        return  # only a manager's machine seeds the shared token
    try:
        st, _ = await api_request("POST", "/team-credentials", json={"shakker_token": token})
        if st == 200:
            _last_pushed_shakker_token = token
            log.info("hub: auto-pushed shared Shakker token to team")
        else:
            log.debug("hub: auto-push shakker token -> %s", st)
    except Exception as e:
        log.debug("hub: auto-push shakker token failed: %s", e)
