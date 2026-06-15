"""Subprocess reCAPTCHA token provider.

Background
==========
Harvesting reCAPTCHA tokens from the SAME browser context that fires the
`aisandbox-pa.googleapis.com` API call is a known automation signal:
Google's bot detector sees "page A executes grecaptcha.enterprise.execute
→ page A immediately fires the protected API call" and flags the session.
Once flagged, every subsequent token from that session is rejected for
~10–15 minutes — the 403 cascade observed in production.

This was worked around by harvesting reCAPTCHA tokens
from a SEPARATE Chrome process that shares only the logged-in cookies
with the main browser. The API call still fires from httpx using the
main session's Bearer token, but the reCAPTCHA token comes from a
context Google has never seen call its API → score stays clean →
far fewer 403s.

This module ports that pattern to RedOne Creative for the Cloak backend
(`browser_backend = "cloak"`). The Chrome backend keeps its existing
in-page harvest path for now.

Lifecycle (singleton-per-account)
=================================
Harvesters are cached at module level keyed by account email. One
account → one harvester process, no matter how many FlowClient
instances (i.e. concurrent tasks) borrow it. This avoids the
"too many Chromium windows" problem when running multi-task workloads.

Cleanup is wired into BrowserManager/CloakBrowserManager.
`_close_account_internal()` — when the main browser for an account is
torn down (account disabled, app shutdown), the harvester goes with it.
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import uuid
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from playwright.async_api import BrowserContext, Page

from ..config import DATA_DIR

log = logging.getLogger("redone.recaptcha")

VIDEO_FX_URL = "https://labs.google/fx/tools/video-fx"

HARVESTER_PROFILES_DIR = DATA_DIR / "browser_profiles" / "cloak_harvest"
HARVESTER_PROFILES_DIR.mkdir(parents=True, exist_ok=True)


_HARVEST_JS = """async (action) => {
    let siteKey = null;
    const scripts = document.querySelectorAll('script[src*="recaptcha"]');
    for (const s of scripts) {
        const m = s.src.match(/[?&]render=([^&]+)/);
        if (m) { siteKey = m[1]; break; }
    }
    if (!siteKey) return {error: 'no_site_key'};
    if (typeof grecaptcha !== 'undefined' && grecaptcha.enterprise) {
        try {
            const token = await grecaptcha.enterprise.execute(
                siteKey, {action: action}
            );
            if (token) return {token, key: siteKey};
            return {error: 'empty_token'};
        } catch(e) {
            return {error: e.message || String(e)};
        }
    }
    return {error: 'grecaptcha_not_available'};
}"""


class BaseTokenProvider(ABC):
    """Common interface for separate-process reCAPTCHA harvesters."""

    @property
    @abstractmethod
    def is_running(self) -> bool: ...

    @abstractmethod
    async def start(self, cookies: list[dict]) -> None: ...

    @abstractmethod
    async def get_token(self, action: str) -> str: ...

    @abstractmethod
    async def refresh_cookies(self, cookies: list[dict]) -> None: ...

    @abstractmethod
    async def stop(self) -> None: ...


class CloakTokenProvider(BaseTokenProvider):
    """Spawn a second CloakBrowser instance whose ONLY job is harvesting
    reCAPTCHA tokens.

    Runs in true headless mode (`headless=True`) so it does NOT appear
    in the taskbar. Cloak's stealth_args (default True) keep
    `navigator.webdriver=false` and friends, so reCAPTCHA enterprise
    still scores it as human in headless. `humanize` is disabled —
    harvester does one `grecaptcha.execute()` per call, no human-like
    mouse behavior to simulate.

    Profile is throwaway: a fresh temp dir under
    `data/browser_profiles/cloak_harvest/` per run, wiped on `stop()`.
    """

    def __init__(self, account_email: str):
        self._account_email = account_email or "?"
        self._context: Optional["BrowserContext"] = None
        self._page: Optional["Page"] = None
        self._profile_dir: Optional[Path] = None
        self._start_lock = asyncio.Lock()
        self._harvest_lock = asyncio.Lock()

    @property
    def is_running(self) -> bool:
        if self._context is None or self._page is None:
            return False
        try:
            return not self._page.is_closed()
        except Exception:
            return False

    async def start(self, cookies: list[dict]) -> None:
        """Launch CloakBrowser instance #2, inject cookies, navigate to
        video-fx. Safe to call multiple times — re-entry is a no-op."""
        async with self._start_lock:
            if self.is_running:
                return

            from cloakbrowser import launch_persistent_context_async
            from .browser_manager import sanitize_cookies

            self._profile_dir = (
                HARVESTER_PROFILES_DIR / f"{uuid.uuid4().hex[:12]}"
            ).resolve()
            self._profile_dir.mkdir(parents=True, exist_ok=True)

            log.info(
                f"[{self._account_email}] Starting headless CloakBrowser "
                f"reCAPTCHA harvester (profile={self._profile_dir.name})..."
            )

            self._context = await launch_persistent_context_async(
                user_data_dir=str(self._profile_dir),
                # True headless — no taskbar entry, no visible window.
                # Cloak's stealth_args still apply, so grecaptcha treats
                # us as a real browser.
                headless=True,
                # humanize requires a visible window for mouse simulation,
                # which we explicitly don't want here.
                humanize=False,
                args=[
                    "--disable-gpu",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-extensions",
                    "--disable-component-update",
                    "--disable-default-apps",
                ],
                viewport={"width": 1280, "height": 720},
                locale="vi-VN",
            )

            # Inject session cookies from main browser BEFORE first navigate
            # so the harvester loads video-fx already signed-in.
            clean = sanitize_cookies(cookies) if cookies else []
            if clean:
                try:
                    await self._context.add_cookies(clean)
                    log.info(
                        f"[{self._account_email}] Harvester: injected "
                        f"{len(clean)} cookies"
                    )
                except Exception as e:
                    log.warning(
                        f"[{self._account_email}] Harvester cookie inject "
                        f"failed: {e}"
                    )

            self._page = (
                self._context.pages[0]
                if self._context.pages
                else await self._context.new_page()
            )

            try:
                await self._page.goto(
                    VIDEO_FX_URL,
                    wait_until="domcontentloaded",
                    timeout=30000,
                )
            except Exception as e:
                if "interrupted by another navigation" in str(e):
                    log.info(
                        f"[{self._account_email}] Harvester landed at "
                        f"{self._page.url}"
                    )
                else:
                    raise

            await asyncio.sleep(2)
            await self._wait_grecaptcha()

    async def _wait_grecaptcha(self) -> None:
        """Block until grecaptcha enterprise object is available (or give
        up after ~15s — `get_token` will surface the failure)."""
        if not self._page:
            return
        for i in range(30):
            try:
                has = await self._page.evaluate(
                    "typeof grecaptcha !== 'undefined' && "
                    "(!!grecaptcha.enterprise || !!grecaptcha.execute)"
                )
            except Exception:
                has = False
            if has:
                if i > 0:
                    log.info(
                        f"[{self._account_email}] Harvester: grecaptcha "
                        f"loaded after {i * 0.5:.1f}s"
                    )
                return
            await asyncio.sleep(0.5)
        log.warning(
            f"[{self._account_email}] Harvester: grecaptcha did not load "
            f"within 15s — first get_token() may fail"
        )

    async def get_token(self, action: str = "VIDEO_GENERATION") -> str:
        """Harvest a fresh reCAPTCHA token. Returns empty string on
        failure (caller decides whether to retry or surface error)."""
        if not self.is_running:
            log.error(
                f"[{self._account_email}] get_token called but harvester "
                f"is not running"
            )
            return ""

        # Serialize multiple concurrent harvest calls on the same provider
        # — the browser page can only execute one grecaptcha.execute()
        # reliably at a time.
        async with self._harvest_lock:
            try:
                result = await self._page.evaluate(_HARVEST_JS, action)
            except Exception as e:
                log.error(
                    f"[{self._account_email}] Harvester evaluate error: {e}"
                )
                return ""

            if isinstance(result, dict) and result.get("token"):
                token = result["token"]
                log.info(
                    f"[{self._account_email}] Harvester got token "
                    f"(key={result.get('key', '')[:10]}...): {token[:20]}..."
                )
                return token

            err = (result or {}).get("error") if isinstance(result, dict) else result
            log.warning(
                f"[{self._account_email}] Harvester returned no token: {err}"
            )
            return ""

    async def refresh_cookies(self, cookies: list[dict]) -> None:
        """Push fresh cookies from main browser into the harvester.
        Called after `FlowClient.renew_token()` reloads the main page —
        the main session's cookies may have rotated and the harvester
        must follow or its requests will be unauthenticated."""
        if not self.is_running:
            return
        try:
            from .browser_manager import sanitize_cookies
            clean = sanitize_cookies(cookies) if cookies else []
            if not clean:
                return
            try:
                await self._context.clear_cookies()
            except Exception:
                pass
            await self._context.add_cookies(clean)
            try:
                await self._page.reload(
                    wait_until="domcontentloaded", timeout=20000
                )
                await asyncio.sleep(1.5)
                await self._wait_grecaptcha()
            except Exception as e:
                log.warning(
                    f"[{self._account_email}] Harvester reload after cookie "
                    f"refresh failed: {e}"
                )
        except Exception as e:
            log.warning(
                f"[{self._account_email}] Harvester refresh_cookies failed: {e}"
            )

    async def stop(self) -> None:
        """Close the CloakBrowser context and wipe the temp profile.
        Idempotent."""
        if self._context is not None:
            try:
                await self._context.close()
            except Exception as e:
                log.debug(
                    f"[{self._account_email}] Harvester context close: {e}"
                )
            self._context = None
            self._page = None

        if self._profile_dir and self._profile_dir.exists():
            try:
                shutil.rmtree(self._profile_dir, ignore_errors=True)
                log.debug(
                    f"[{self._account_email}] Harvester profile dir wiped: "
                    f"{self._profile_dir.name}"
                )
            except Exception:
                pass
            self._profile_dir = None


# ── Singleton cache ─────────────────────────────────────────────────
# Keyed by account email. Lifetime is tied to the corresponding main
# browser (BrowserManager / CloakBrowserManager call `release_for_account`
# from their _close_account_internal). Outlives individual FlowClient
# instances — multiple concurrent tasks on the same account share one
# harvester instead of spawning N Chromium windows.

_HARVESTER_CACHE: dict[str, BaseTokenProvider] = {}
_CACHE_LOCK = asyncio.Lock()


async def get_or_create(account_email: str) -> Optional[BaseTokenProvider]:
    """Return cached harvester for this account, or create a new one.

    Returns None if the current backend setting has no subprocess
    harvester implementation yet (currently: Chrome backend).

    Caller is responsible for calling `start(cookies)` before first use.
    """
    try:
        from ..database import db
        backend = (db.get_setting("browser_backend", "chrome") or "chrome").lower()
    except Exception:
        backend = "chrome"

    if backend != "cloak":
        return None

    key = account_email or "?"
    async with _CACHE_LOCK:
        existing = _HARVESTER_CACHE.get(key)
        if existing is not None and existing.is_running:
            return existing
        # Either no entry, or the cached one died (browser crash etc.)
        if existing is not None:
            try:
                await existing.stop()
            except Exception:
                pass
            _HARVESTER_CACHE.pop(key, None)

        provider = CloakTokenProvider(account_email)
        _HARVESTER_CACHE[key] = provider
        return provider


async def release_for_account(account_email: str) -> None:
    """Stop and forget the harvester for this account. Called by
    BrowserManager/CloakBrowserManager when they tear down the main
    browser for an account."""
    key = account_email or "?"
    async with _CACHE_LOCK:
        provider = _HARVESTER_CACHE.pop(key, None)
    if provider is not None:
        try:
            await provider.stop()
            log.info(f"[{key}] Harvester released")
        except Exception as e:
            log.debug(f"[{key}] Harvester release error: {e}")


async def release_all() -> None:
    """Tear down every cached harvester. Call from app shutdown."""
    async with _CACHE_LOCK:
        providers = list(_HARVESTER_CACHE.items())
        _HARVESTER_CACHE.clear()
    for key, provider in providers:
        try:
            await provider.stop()
        except Exception as e:
            log.debug(f"[{key}] Harvester shutdown error: {e}")
