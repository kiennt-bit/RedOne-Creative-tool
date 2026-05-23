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


def _read_auth_mode() -> str:
    """Return 'extension' (default) or 'playwright'. Fresh read on every
    call so user can switch in Settings without a restart."""
    try:
        from ..database import db
        val = (db.get_setting("auth_mode", "extension") or "extension").lower()
        if val in ("extension", "playwright"):
            return val
    except Exception:
        pass
    return "extension"


async def get_page_for_account(account: dict):
    """Open a Playwright page for the account if and only if we're in
    legacy Playwright mode. In extension mode there's no page — returns
    None and the caller skips browser spawn entirely.

    Saves routers from having to know the auth mode themselves.
    """
    if _read_auth_mode() == "extension":
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
    """Construct the appropriate FlowClient subclass for the current
    auth_mode setting.

    Both classes have the same public API — routers never need to
    branch on which one they got.

    Args:
        page: Playwright Page (only used by legacy FlowClient — ignored
              in bridge mode but accepted for signature compatibility).
        cookie_path: Legacy cookie JSON path (also ignored by bridge).
        account_email: Identifies which account this client is for —
              used in logs + per-account locks.
    """
    mode = _read_auth_mode()
    if mode == "extension":
        from .flow_client_bridge import BridgeFlowClient
        return BridgeFlowClient(
            page=None,  # bridge mode doesn't use a page
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
