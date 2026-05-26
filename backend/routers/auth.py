"""Login / logout / session-check endpoints for the OAuth gate.

Wired up in main.py. The auth middleware (also in main.py) consults
`oauth_auth.load_session()` before letting `/api/*` requests through.

Endpoints
=========

    GET  /auth/login        Redirect to Google OAuth consent
    GET  /auth/callback     Google redirects here with the auth code
    GET  /auth/me           JSON {logged_in, email, name, picture, ...}
    POST /auth/logout       Clear the local session

The flow is intentionally split so a static `/login.html` page can
call `/auth/login` as a plain `<a href>` link — no JS auth library needed.
"""
from __future__ import annotations

import logging
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import RedirectResponse, JSONResponse

from ..services.oauth_auth import (
    build_login_url,
    exchange_code,
    is_email_allowed,
    save_session,
    load_session,
    clear_session,
    is_configured,
    get_allowed_domain,
    _consume_state,
)

log = logging.getLogger("redone.auth_router")
router = APIRouter(prefix="/auth", tags=["auth"])


def _redirect_uri(request: Request) -> str:
    """Build the absolute redirect URI Google will call back to.

    Must EXACTLY match one of the URIs registered in the OAuth client.
    We pick based on the host the user hit — so both `127.0.0.1` and
    `localhost` work.
    """
    host = request.headers.get("host") or "127.0.0.1:8000"
    scheme = "http"  # local dev/EXE always http on loopback
    return f"{scheme}://{host}/auth/callback"


@router.get("/login")
async def login(request: Request):
    """Redirect the browser to Google's consent screen."""
    if not is_configured():
        return JSONResponse(
            {"error": "OAuth chưa cấu hình — admin cần điền credentials trong backend/private_config.py"},
            status_code=503,
        )
    url = build_login_url(_redirect_uri(request))
    return RedirectResponse(url=url, status_code=302)


@router.get("/callback")
async def callback(request: Request, code: str = "", state: str = "", error: str = ""):
    """Google sends the user here after consent.

    On success we create a local session and redirect to /, where the
    SPA reloads with the user authenticated. On any failure we redirect
    back to /login.html with an error query so the page can show why.
    """
    # User cancelled at Google's consent screen
    if error:
        log.info(f"auth callback: Google returned error={error!r}")
        return RedirectResponse(url=f"/login.html?error={error}", status_code=302)

    if not code:
        return RedirectResponse(url="/login.html?error=no_code", status_code=302)

    # CSRF protection — consume the state we generated in /auth/login
    if not _consume_state(state):
        log.warning("auth callback: invalid or expired state — possible CSRF")
        return RedirectResponse(url="/login.html?error=bad_state", status_code=302)

    # Exchange the code for user info
    try:
        user = await exchange_code(code, _redirect_uri(request))
    except Exception as e:
        log.exception("auth callback: token exchange failed")
        return RedirectResponse(
            url=f"/login.html?error=exchange_failed&detail={str(e)[:120]}",
            status_code=302,
        )

    email = (user.get("email") or "").lower()
    if not is_email_allowed(email):
        log.warning(f"auth callback: rejected non-domain email {email!r}")
        return RedirectResponse(
            url=f"/login.html?error=domain&email={email}",
            status_code=302,
        )

    # All checks passed — persist the session and bounce back to /
    save_session(user)
    return RedirectResponse(url="/", status_code=302)


@router.get("/me")
async def me():
    """Return the current session, or `{logged_in: False}` if none.
    Frontend's app boot calls this; on `False`, redirects to /login.html.
    """
    rec = load_session()
    if rec is None:
        return {
            "logged_in": False,
            "allowed_domain": get_allowed_domain(),
            "oauth_configured": is_configured(),
        }
    return {
        "logged_in": True,
        "email":   rec.get("email"),
        "name":    rec.get("name"),
        "picture": rec.get("picture"),
        "expires_at": rec.get("expires_at"),
        "allowed_domain": get_allowed_domain(),
    }


@router.post("/logout")
async def logout():
    """Clear the local session. Browser redirects to /login.html next."""
    clear_session()
    return {"ok": True}
