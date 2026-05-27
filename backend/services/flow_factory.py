"""Factory for picking the right FlowClient implementation at runtime.

The new default is `BridgeFlowClient` — routes everything through the
Chrome extension to dodge Google's 403 cascade. The legacy Playwright
`FlowClient` is kept as a fallback (setting `auth_mode = "playwright"`)
so we can roll back without redeploying if the bridge has issues.

Routers should call `make_flow_client(...)` instead of constructing a
FlowClient directly. The signature returned is the same in both modes
(see flow_client.py for the public API surface).
"""
from __future__ import annotations
import logging
from typing import Optional

log = logging.getLogger("redone.flow_factory")


VALID_AUTH_MODES = ("extension", "playwright", "vertex_api")


def _default_auth_mode() -> str:
    """Auth mode to use when the user hasn't explicitly picked one yet.

    A build that ships baked Vertex AI service-account credentials in
    private_config.py is a commercial distribution → default to 'vertex_api'
    so a fresh machine generates out-of-box (Vertex authenticates via the
    baked service account, no per-user Google login needed). Builds WITHOUT
    those creds default to the free Chrome-extension bridge as before.

    Note: this is only consulted when the `auth_mode` setting is absent. The
    moment a user saves a mode in Settings (e.g. on the dev machine), that
    saved value wins and this function is never reached — so existing setups
    are unaffected.
    """
    try:
        from .. import private_config as _pc  # type: ignore
        info = getattr(_pc, "VERTEX_SERVICE_ACCOUNT_INFO", None)
        if isinstance(info, dict) and info.get("private_key"):
            return "vertex_api"
    except Exception:
        pass
    return "extension"


def _read_auth_mode() -> str:
    """Return one of VALID_AUTH_MODES. Fresh read on every call so the user
    can switch in Settings without a restart. When the setting is unset,
    falls back to _default_auth_mode()."""
    try:
        from ..database import db
        raw = db.get_setting("auth_mode", None)
        if raw:
            val = str(raw).lower()
            if val in VALID_AUTH_MODES:
                return val
    except Exception:
        pass
    return _default_auth_mode()


def is_vertex_mode() -> bool:
    """True when the active auth mode is Vertex AI (commercial)."""
    return _read_auth_mode() == "vertex_api"


def synthetic_vertex_account() -> dict:
    """Placeholder 'account' for Vertex mode.

    Vertex authenticates with the baked service account, not a per-user
    Google login — but the generation pipeline expects an account row. On a
    fresh machine with zero accounts added, hand back this synthetic one so
    gen proceeds. id=0 means any db.update_account() call no-ops (no such
    row), which is fine because Vertex never reports a dead session.
    """
    return {
        "id": 0,
        "email": "Vertex AI (service account)",
        "enabled": 1,
        "credit": None,
        "cookie_path": "",
    }


async def get_page_for_account(account: dict):
    """Open a Playwright page for the account if and only if we're in
    legacy Playwright mode. In extension / vertex_api mode there's no
    page — returns None and the caller skips browser spawn entirely.

    Saves routers from having to know the auth mode themselves.
    """
    mode = _read_auth_mode()
    if mode in ("extension", "vertex_api"):
        return None
    from .browser_manager import BrowserManager
    bm = BrowserManager()
    return await bm.get_page(
        account["id"], account["email"],
        cookie_path=account.get("cookie_path"),
    )


def make_flow_client(
    page=None,
    cookie_path: str = "",
    account_email: str = "",
):
    """Construct the appropriate FlowClient implementation for the current
    auth_mode setting.

    All variants implement the same public API so routers never branch
    on which one they got.

    Args:
        page: Playwright Page (only used by legacy FlowClient — ignored
              in bridge / vertex modes but accepted for signature compat).
        cookie_path: Legacy cookie JSON path (ignored outside playwright mode).
        account_email: Identifies which account this client is for —
              used in logs + per-account locks.

    Modes
    -----
    "extension" (default): BridgeFlowClient — talks to Chrome extension,
        uses user's real Chrome session (free Labs Flow quota, no 403).
    "playwright": Legacy FlowClient — spawns Cloak/Chrome browser, uses
        per-account cookie JSON files (free Labs Flow quota).
    "vertex_api": VertexFlowClient — commercial Google Cloud Vertex AI
        (pay-per-call). Requires API key + service account JSON config
        in Settings.
    """
    mode = _read_auth_mode()
    if mode == "vertex_api":
        from .vertex_client import VertexFlowClient
        return VertexFlowClient(
            page=None,
            cookie_path=cookie_path,
            account_email=account_email,
        )
    if mode == "extension":
        from .flow_client_bridge import BridgeFlowClient
        return BridgeFlowClient(
            page=None,
            cookie_path=cookie_path,
            account_email=account_email,
        )
    # Legacy Playwright path
    from .flow_client import FlowClient
    return FlowClient(
        page=page,
        cookie_path=cookie_path,
        account_email=account_email,
    )
