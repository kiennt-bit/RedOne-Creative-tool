"""CloakBrowser backend — stealth Chromium alternative to system Chrome.

When enabled via settings (`browser_backend = "cloak"`), all browser
operations route through cloakbrowser's `launch_persistent_context_async`
instead of Playwright's `chromium.launch`. The patched Chromium binary
ships ~200MB and auto-downloads on first use (cached in
`%LOCALAPPDATA%\\cloakbrowser` on Windows).

This module mirrors the public interface of `browser_manager.BrowserManager`
so the dispatcher in `browser_manager.get_page()` can call either
backend transparently.
"""
from __future__ import annotations
import asyncio
import json
import logging
from pathlib import Path
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from playwright.async_api import BrowserContext, Page

from .browser_manager import sanitize_cookies
from ..config import DATA_DIR

log = logging.getLogger("vidgen.cloak")

CLOAK_PROFILES_DIR = DATA_DIR / "browser_profiles" / "cloak"
CLOAK_PROFILES_DIR.mkdir(parents=True, exist_ok=True)


def is_available() -> tuple[bool, Optional[str]]:
    """Return (installed, error_message)."""
    try:
        import cloakbrowser  # noqa: F401
        return True, None
    except ImportError as e:
        return False, str(e)


class CloakBrowserManager:
    """Persistent-context based stealth browser manager.

    Each account_id gets its own persistent profile dir:
        data/browser_profiles/cloak/<account_id>/
    Cookies persist there natively (no separate JSON injection needed
    after first login).
    """

    FLOW_URL = "https://labs.google/fx/tools/video-fx"

    def __init__(self):
        self._contexts: dict[int, "BrowserContext"] = {}
        self._pages: dict[int, "Page"] = {}
        self._ref_counts: dict[int, int] = {}
        self._lock = asyncio.Lock()

    # ────────────────────── Public API ──────────────────────

    async def get_page(
        self,
        account_id: int,
        email: str,
        cookie_path: str,
        url: str = "",
    ) -> "Page":
        """Get or create a stealth page for an account."""
        self._ref_counts[account_id] = self._ref_counts.get(account_id, 0) + 1

        async with self._lock:
            # Reuse alive page
            if account_id in self._pages:
                page = self._pages[account_id]
                if not page.is_closed():
                    try:
                        await page.evaluate("1+1")
                        if url and url not in (page.url or ""):
                            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
                        return page
                    except Exception:
                        log.warning(f"Cloak page stale for {email}, recreating...")
                        await self._close_account_internal(account_id)

            return await self._create_page(account_id, email, cookie_path, url)

    async def close_context(self, account_id: int):
        self._ref_counts[account_id] = self._ref_counts.get(account_id, 1) - 1
        if self._ref_counts[account_id] > 0:
            return
        async with self._lock:
            await self._close_account_internal(account_id)

    # ────────────────────── Internal ──────────────────────

    async def _create_page(
        self,
        account_id: int,
        email: str,
        cookie_path: str,
        url: str,
    ) -> "Page":
        ok, err = is_available()
        if not ok:
            raise RuntimeError(
                f"cloakbrowser chưa được cài: {err}. "
                "Cài bằng `pip install cloakbrowser`, sau đó restart tool."
            )

        # Lazy import — cloakbrowser may not be installed
        from cloakbrowser import launch_persistent_context_async

        profile_dir = (CLOAK_PROFILES_DIR / str(account_id)).resolve()
        profile_dir.mkdir(parents=True, exist_ok=True)

        log.info(f"Launching CloakBrowser persistent context for {email}...")
        log.info(f"  Profile dir: {profile_dir}")

        # Off-screen window; humanize=True enables natural mouse/scroll patterns
        try:
            context = await launch_persistent_context_async(
                user_data_dir=str(profile_dir),
                headless=False,
                humanize=True,
                args=[
                    "--window-position=-10000,-10000",
                    "--window-size=1280,720",
                    "--disable-gpu",
                    "--no-first-run",
                    "--no-default-browser-check",
                ],
                viewport={"width": 1280, "height": 720},
                locale="vi-VN",
            )
        except Exception as e:
            log.exception("CloakBrowser launch failed")
            raise RuntimeError(
                f"Không khởi động được CloakBrowser: {e}. "
                "Lần đầu cần internet để download binary ~200MB."
            )
        self._contexts[account_id] = context

        # If account already has cookies in JSON form (from a previous Chrome
        # session), inject them into the fresh Cloak profile.
        cookies = self._load_cookies(cookie_path)
        if cookies:
            try:
                await context.add_cookies(cookies)
                log.info(f"Imported {len(cookies)} cookies into Cloak profile for {email}")
            except Exception as e:
                log.warning(f"Failed to add cookies: {e}")

        page = (context.pages[0] if context.pages else await context.new_page())
        self._pages[account_id] = page

        target = url or self.FLOW_URL
        log.info(f"Navigating Cloak page to {target}...")
        try:
            await page.goto(target, wait_until="domcontentloaded", timeout=30000)
        except Exception as e:
            if "interrupted by another navigation" in str(e):
                log.info(f"Navigation redirected to {page.url}")
            else:
                raise

        await asyncio.sleep(2)
        return page

    def _load_cookies(self, cookie_path: str) -> list[dict]:
        if not cookie_path:
            return []
        path = Path(cookie_path)
        if not path.exists():
            return []
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                return sanitize_cookies(raw)
        except Exception as e:
            log.error(f"Failed to load cookies from {path}: {e}")
        return []

    async def _close_account_internal(self, account_id: int):
        if account_id in self._pages:
            try:
                if not self._pages[account_id].is_closed():
                    await self._pages[account_id].close()
            except Exception:
                pass
            del self._pages[account_id]

        if account_id in self._contexts:
            try:
                await self._contexts[account_id].close()
            except Exception:
                pass
            del self._contexts[account_id]

        self._ref_counts.pop(account_id, None)


# Singleton for app-wide use
_singleton: Optional[CloakBrowserManager] = None


def get_cloak_manager() -> CloakBrowserManager:
    global _singleton
    if _singleton is None:
        _singleton = CloakBrowserManager()
    return _singleton
