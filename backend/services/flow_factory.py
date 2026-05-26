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


def _read_auth_mode() -> str:
    """Return one of VALID_AUTH_MODES (default 'extension'). Fresh read on
    every call so user can switch in Settings without a restart."""
    try:
        from ..database import db
        val = (db.get_setting("auth_mode", "extension") or "extension").lower()
        if val in VALID_AUTH_MODES:
            return val
    except Exception:
        pass
    return "extension"


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
