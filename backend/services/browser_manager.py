"""VidGen Pro — Browser manager (cloned from NAV Tools).

Strategy (NAV Tools pattern):
  - Uses REAL Chrome binary (not Playwright bundled Chromium)
  - headless=False but window positioned off-screen (invisible)
  - Anti-detection scripts to bypass Google bot detection
  - Cookie injection from exported JSON files
  - Shared instances with ref counting
"""

import asyncio
import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Optional
import logging

from playwright.async_api import async_playwright, Browser, BrowserContext, Page

log = logging.getLogger("vidgen.browser")


# ── Chrome finder (NAV Tools) ────────────────────────────────

def find_chrome() -> Optional[str]:
    """Find system Chrome executable (Windows/Mac/Linux)."""
    if os.name == "nt":
        candidates = [
            os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%ProgramFiles%\Google\Chrome Beta\Application\chrome.exe"),
        ]
        # Registry fallback
        try:
            import winreg
            for root in [winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER]:
                try:
                    key = winreg.OpenKey(root, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe")
                    path, _ = winreg.QueryValueEx(key, "")
                    winreg.CloseKey(key)
                    if os.path.isfile(path):
                        return path
                except Exception:
                    pass
        except ImportError:
            pass
    elif sys.platform == "darwin":
        candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            os.path.expanduser("~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ]
    else:
        candidates = [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium-browser",
            "/usr/bin/chromium",
        ]
    
    for path in candidates:
        if os.path.isfile(path):
            return path
    
    # which/where fallback
    found = shutil.which("chrome") or shutil.which("google-chrome")
    return found


# ── Cookie sanitizer ─────────────────────────────────────────

def sanitize_cookies(raw_cookies: list[dict]) -> list[dict]:
    """Sanitize Cookie-Editor JSON for Playwright.
    
    Normalizes sameSite, removes invalid fields, ensures security flags.
    """
    sanitized = []
    for c in raw_cookies:
        cookie = dict(c)
        
        # Normalize sameSite (Cookie-Editor exports 'no_restriction')
        if "sameSite" in cookie:
            ss = str(cookie["sameSite"]).lower()
            if ss in ("no_restriction", "none"):
                cookie["sameSite"] = "None"
                cookie["secure"] = True
            elif ss == "lax":
                cookie["sameSite"] = "Lax"
            elif ss == "strict":
                cookie["sameSite"] = "Strict"
            else:
                del cookie["sameSite"]
        
        # Remove Cookie-Editor specific fields Playwright doesn't accept
        for field in ["id", "storeId", "session", "hostOnly"]:
            cookie.pop(field, None)
        
        if "name" in cookie and "value" in cookie:
            sanitized.append(cookie)
    
    return sanitized


# ── Browser Manager ──────────────────────────────────────────

class BrowserManager:
    """Manages Chrome browser instances with anti-detection.
    
    Cloned from NAV Tools BrowserManager:
    - Real Chrome binary (better fingerprint)
    - headless=False, hidden off-screen
    - Anti-detection init scripts
    - Per-account browser isolation
    - Ref counting for shared access
    """
    
    FLOW_URL = "https://labs.google/fx/tools/video-fx"
    
    def __init__(self):
        self._playwrights: dict[int, any] = {}
        self._browsers: dict[int, Browser] = {}
        self._contexts: dict[int, BrowserContext] = {}
        self._pages: dict[int, Page] = {}
        self._ref_counts: dict[int, int] = {}
        self._lock = asyncio.Lock()
    
    async def get_page(
        self,
        account_id: int,
        email: str,
        cookie_path: str,
        url: str = "",
    ) -> Page:
        """Get or create a page for an account (NAV Tools pattern).
        
        Reuses existing context if alive, otherwise creates new one.
        """
        self._ref_counts[account_id] = self._ref_counts.get(account_id, 0) + 1
        
        async with self._lock:
            # Check if existing page is alive
            if account_id in self._pages:
                page = self._pages[account_id]
                if not page.is_closed():
                    try:
                        await page.evaluate("1+1")
                        if url and url not in (page.url or ""):
                            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
                        return page
                    except Exception:
                        log.warning(f"Page stale for {email}, recreating...")
                        await self._close_account_internal(account_id)
            
            return await self._create_page(account_id, email, cookie_path, url)
    
    async def _create_page(
        self,
        account_id: int,
        email: str,
        cookie_path: str,
        url: str,
    ) -> Page:
        """Create new browser page with anti-detection (NAV Tools)."""
        # Start Playwright instance for this account
        pw = await async_playwright().start()
        self._playwrights[account_id] = pw
        
        # Find system Chrome
        chrome_exe = find_chrome()
        if chrome_exe:
            log.info(f"Using system Chrome: {chrome_exe}")
        else:
            log.info("System Chrome not found, using bundled Chromium")
        
        # Launch (NAV Tools: headless=False, hidden off-screen)
        browser = await pw.chromium.launch(
            headless=False,
            executable_path=chrome_exe,
            args=[
                "--window-position=-10000,-10000",
                "--window-size=1,1",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-default-apps",
                "--disable-blink-features=AutomationControlled",
                "--disable-infobars",
                "--disable-extensions",
                "--disable-features=TranslateUI,GlobalMediaControls",
            ],
        )
        self._browsers[account_id] = browser
        
        # Create context with anti-detection scripts (NAV Tools)
        context = await browser.new_context()
        self._contexts[account_id] = context
        
        await context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['vi-VN', 'vi', 'en-US', 'en'] });
        """)
        
        # Load and inject cookies
        cookies = self._load_cookies(cookie_path)
        if cookies:
            await context.add_cookies(cookies)
            log.info(f"Loaded {len(cookies)} cookies for {email}")
        else:
            log.warning(f"No cookies found for {email} at {cookie_path}")
        
        # Create page and navigate
        page = await context.new_page()
        self._pages[account_id] = page
        
        target = url or self.FLOW_URL
        log.info(f"Navigating to {target} for {email}...")
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
        """Load and sanitize cookies from JSON file."""
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
    
    async def close_context(self, account_id: int):
        """Close browser for account (with ref counting like NAV Tools)."""
        self._ref_counts[account_id] = self._ref_counts.get(account_id, 1) - 1
        if self._ref_counts[account_id] > 0:
            return
        
        async with self._lock:
            await self._close_account_internal(account_id)
    
    async def _close_account_internal(self, account_id: int):
        """Internal close without lock (call from within locked context)."""
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
        
        if account_id in self._browsers:
            try:
                await self._browsers[account_id].close()
            except Exception:
                pass
            del self._browsers[account_id]
        
        if account_id in self._playwrights:
            try:
                await self._playwrights[account_id].stop()
            except Exception:
                pass
            del self._playwrights[account_id]
        
        self._ref_counts.pop(account_id, None)
        log.info(f"Closed browser for account_id={account_id}")
    
    async def stop_all(self):
        """Close all browser instances."""
        for account_id in list(self._browsers.keys()):
            await self._close_account_internal(account_id)
        log.info("All browsers stopped")
    
    def is_open(self, account_id: int) -> bool:
        return account_id in self._browsers
    
    @property
    def active_count(self) -> int:
        return len(self._browsers)
