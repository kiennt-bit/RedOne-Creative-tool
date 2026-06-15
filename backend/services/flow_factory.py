"""Factory for the FlowClient implementation.

The tool now runs in a SINGLE auth mode: the Chrome-extension bridge
(`BridgeFlowClient`). The legacy Playwright/Cloak browser path and the
commercial Vertex AI path have been REMOVED — every generation routes
through the user's real Chrome session via the "RedOne Auth Helper"
extension (free Labs Flow quota, no 403 cascade, no paid API).

Routers call `make_flow_client(...)` plus the mode-helper functions below;
their signatures are unchanged so no router has to branch on auth mode.
The legacy service modules (`flow_client.py`, `vertex_client.py`,
`cloak_backend.py`, `browser_manager.py`) are left on disk but are no
longer reachable from here.
"""
from __future__ import annotations
import logging

log = logging.getLogger("redone.flow_factory")

# Only one mode remains. Kept as a tuple so any leftover code that imports
# it (e.g. validation) still resolves cleanly.
VALID_AUTH_MODES = ("extension",)


def _read_auth_mode() -> str:
    """Always 'extension' — Vertex + Playwright/Cloak modes were removed.

    Returning a constant also self-heals machines that still have an old
    `auth_mode=vertex_api|playwright` value saved in their DB: that stored
    value is now ignored, so the tool can never fall back to a dead mode.
    """
    return "extension"


def is_vertex_mode() -> bool:
    """Vertex AI mode was removed — always False."""
    return False


def synthetic_vertex_account() -> dict:
    """Deprecated. Vertex mode is gone, so this is never reached (callers
    gate on `is_vertex_mode()`, which is now always False). Kept defined
    only so existing `from flow_factory import synthetic_vertex_account`
    imports don't break."""
    return {
        "id": 0,
        "email": "Vertex AI (service account)",
        "enabled": 1,
        "credit": None,
        "cookie_path": "",
    }


async def get_page_for_account(account: dict):
    """No Playwright browser anymore — extension mode never opens a page.
    Always returns None so routers skip browser spawn entirely."""
    return None


def make_flow_client(
    page=None,
    cookie_path: str = "",
    account_email: str = "",
):
    """Construct the FlowClient. Only the Chrome-extension bridge remains.

    `page` / `cookie_path` are accepted for signature compatibility with
    the old callers but ignored — the bridge uses the live Chrome session.
    """
    from .flow_client_bridge import BridgeFlowClient
    return BridgeFlowClient(
        page=None,
        cookie_path=cookie_path,
        account_email=account_email,
    )
