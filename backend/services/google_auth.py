"""VidGen Pro — Google authentication (cloned from NAV Tools).

Handles:
  - Session validation via browser
  - Login flow via manual browser window
  - Cookie export after login
  - Credit and tier detection
"""

import asyncio
import json
import logging
import os
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from playwright.async_api import Page, BrowserContext

log = logging.getLogger("vidgen.auth")


class GoogleAuth:
    """Google authentication manager (NAV Tools pattern)."""
    
    ACCOUNTS_URL = "https://accounts.google.com"
    FLOW_URL = "https://labs.google/fx/tools/video-fx"
    MYACCOUNT_URL = "https://myaccount.google.com"
    
    def __init__(self, browser_mgr, account_mgr):
        self._browser = browser_mgr
        self._account_mgr = account_mgr
    
    async def check_session(self, acc) -> bool:
        """Check if account session is still valid (NAV Tools).
        
        Returns True if the account can access Flow without login redirect.
        """
        try:
            page = await self._browser.get_page(
                account_id=acc.id,
                email=acc.email,
                cookie_path=acc.cookie_path,
                url=self.FLOW_URL,
            )
            await page.wait_for_load_state("domcontentloaded", timeout=15000)
            current_url = page.url
            
            # If redirected to accounts.google.com → session expired
            if "accounts.google.com" in current_url:
                log.warning(f"Session expired for {acc.email}")
                return False
            
            # Check if Flow app is accessible
            logged_in = await self._is_flow_accessible(page)
            if logged_in:
                log.info(f"Session valid for {acc.email}")
                return True
            
            return False
        except Exception as e:
            log.error(f"Session check failed for {acc.email}: {e}")
            return False
    
    async def login_account(self, acc) -> bool:
        """Open REAL Chrome for manual Google login.
        
        Strategy: Launch Chrome as a normal subprocess (NOT through Playwright).
        Then connect via CDP to monitor login state and extract cookies.
        This makes Chrome 100% real — Google cannot detect automation.
        """
        from playwright.async_api import async_playwright
        import subprocess
        import socket
        
        log.info(f"Starting login for {acc.email}...")
        
        from browser_manager import find_chrome
        chrome_exe = find_chrome()
        if not chrome_exe:
            log.error("Chrome not found!")
            return False
        
        # Find a free port for CDP
        debug_port = self._find_free_port()
        
        # Create a dedicated user-data-dir so it doesn't conflict with user's Chrome
        user_data_dir = (Path("browser_profiles") / f"login_{acc.id}").resolve()
        user_data_dir.mkdir(parents=True, exist_ok=True)
        
        # Launch Chrome as a REAL subprocess — no Playwright involvement
        # Must use absolute path for --user-data-dir (spaces in path)
        chrome_args = [
            chrome_exe,
            f"--remote-debugging-port={debug_port}",
            f"--user-data-dir={user_data_dir}",
            "--no-first-run",
            "--no-default-browser-check",
            "--window-size=800,700",
            "--window-position=0,0",
            self.ACCOUNTS_URL,  # Open directly at Google accounts
        ]
        
        log.info(f"Launching real Chrome on CDP port {debug_port}, profile: {user_data_dir}")
        # CREATE_NEW_PROCESS_GROUP forces a truly independent Chrome process
        chrome_proc = subprocess.Popen(
            chrome_args,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0,
        )
        
        # Wait for Chrome to fully start
        await asyncio.sleep(5)
        
        pw = None
        browser = None
        try:
            # Connect to Chrome via CDP
            pw = await async_playwright().start()
            cdp_url = f"http://127.0.0.1:{debug_port}"
            
            # Retry connection — Chrome may take a while to start
            for attempt in range(20):
                try:
                    browser = await pw.chromium.connect_over_cdp(cdp_url)
                    log.info(f"CDP connected on attempt {attempt+1}")
                    break
                except Exception as conn_err:
                    if attempt == 19:
                        log.error(f"CDP connection failed after 20 attempts: {conn_err}")
                    await asyncio.sleep(1)
            
            if not browser:
                log.error("Failed to connect to Chrome via CDP. Is another Chrome using this profile?")
                chrome_proc.terminate()
                if pw: await pw.stop()
                return False
            
            log.info(f"Connected to Chrome. Waiting for user to login {acc.email}...")
            
            # Get the default context (the real Chrome context)
            context = browser.contexts[0] if browser.contexts else None
            if not context:
                log.error("No browser context found")
                chrome_proc.terminate()
                await pw.stop()
                return False
            
            # Wait for user to complete login (up to 5 minutes)
            logged_in = False
            for _ in range(300):
                await asyncio.sleep(1)
                try:
                    pages = context.pages
                    if pages:
                        curr = pages[0].url
                        if "myaccount.google.com" in curr or "labs.google" in curr:
                            logged_in = True
                            break
                except Exception:
                    pass
            
            if logged_in:
                log.info(f"Login detected for {acc.email}")
                await self._export_cookies(acc, context)
                # Close Chrome gracefully
                try:
                    chrome_proc.terminate()
                except Exception:
                    pass
                await pw.stop()
                return True
            else:
                log.error(f"Login timeout/failed for {acc.email}")
                try:
                    chrome_proc.terminate()
                except Exception:
                    pass
                await pw.stop()
                return False
                
        except Exception as e:
            log.error(f"Login error for {acc.email}: {e}")
            try:
                chrome_proc.terminate()
            except Exception:
                pass
            if pw:
                try:
                    await pw.stop()
                except Exception:
                    pass
            return False

    async def _is_logged_in(self, page: Page, email: str) -> bool:
        """Check if page shows logged-in state (NAV Tools)."""
        current_url = page.url
        if "accounts.google.com/signin" in current_url:
            return False
        if "myaccount.google.com" in current_url:
            return True
        try:
            avatar = await page.query_selector(
                'img[data-profileimageid], a[aria-label*="Account"]'
            )
            return avatar is not None
        except Exception:
            return False
    
    async def _is_flow_accessible(self, page: Page) -> bool:
        """Check if Flow app is accessible (not redirected to login)."""
        try:
            flow_element = await page.query_selector(
                'text="Create", [data-testid], .mdc-text-field'
            )
            return flow_element is not None
        except Exception:
            return False
    
    async def _export_cookies(self, acc, context: BrowserContext):
        """Export cookies to JSON file after successful login (NAV Tools)."""
        try:
            cookies = await context.cookies()
            
            # Ensure cookies directory exists
            cookies_dir = Path("cookies")
            cookies_dir.mkdir(exist_ok=True)
            
            # Build cookie file path
            cookie_path = cookies_dir / f"{acc.email.replace('@', '_at_')}.json"
            
            # Filter and save cookies
            cookies_data = [
                {k: v for k, v in c.items() if k in [
                    "name", "value", "domain", "path",
                    "expires", "httpOnly", "secure", "sameSite"
                ]}
                for c in cookies
            ]
            
            cookie_path.write_text(
                json.dumps(cookies_data, indent=2, ensure_ascii=False),
                encoding="utf-8"
            )
            
            # Update account
            acc.cookie_path = str(cookie_path)
            
            # Find max cookie expiry
            max_exp = max((c.get("expires", 0) for c in cookies), default=0)
            if max_exp > 0:
                acc.cookie_expiry = datetime.fromtimestamp(max_exp).isoformat()
            
            acc.status = "active"
            self._account_mgr.save()
            
            log.info(f"Exported {len(cookies_data)} cookies for {acc.email} → {cookie_path}")
        except Exception as e:
            log.error(f"Failed to export cookies for {acc.email}: {e}")

    async def login_new_account(self, tier: str = "ULTRA") -> Optional[dict]:
        """Open REAL Chrome for new account login.
        
        Launches Chrome as subprocess → user logs into Google Labs →
        connects via CDP to extract email & cookies.
        """
        from playwright.async_api import async_playwright
        import subprocess
        import uuid
        
        log.info("Starting login for NEW account...")
        
        from browser_manager import find_chrome
        chrome_exe = find_chrome()
        if not chrome_exe:
            log.error("Chrome not found!")
            return None
        
        debug_port = self._find_free_port()
        
        temp_id = uuid.uuid4().hex[:8]
        user_data_dir = (Path("browser_profiles") / f"login_new_{temp_id}").resolve()
        user_data_dir.mkdir(parents=True, exist_ok=True)
        
        # Launch Chrome as a REAL subprocess
        chrome_args = [
            chrome_exe,
            f"--remote-debugging-port={debug_port}",
            f"--user-data-dir={user_data_dir}",
            "--no-first-run",
            "--no-default-browser-check",
            "--window-size=800,700",
            "--window-position=0,0",
            "https://labs.google/fx/tools/video-fx",
        ]
        
        log.info(f"Launching real Chrome on CDP port {debug_port}, profile: {user_data_dir}")
        chrome_proc = subprocess.Popen(
            chrome_args,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0,
        )
        
        await asyncio.sleep(5)
        
        pw = None
        browser = None
        try:
            pw = await async_playwright().start()
            cdp_url = f"http://127.0.0.1:{debug_port}"
            
            for attempt in range(20):
                try:
                    browser = await pw.chromium.connect_over_cdp(cdp_url)
                    log.info(f"CDP connected on attempt {attempt+1}")
                    break
                except Exception as conn_err:
                    if attempt == 19:
                        log.error(f"CDP connection failed after 20 attempts: {conn_err}")
                    await asyncio.sleep(1)
            
            if not browser:
                log.error("Failed to connect to Chrome via CDP. Is another Chrome using this profile?")
                chrome_proc.terminate()
                if pw: await pw.stop()
                return None
            
            context = browser.contexts[0] if browser.contexts else None
            if not context:
                log.error("No browser context found")
                chrome_proc.terminate()
                await pw.stop()
                return None
            
            log.info("Connected. Waiting for user to login...")
            
            # Wait for login (up to 5 minutes)
            logged_in = False
            for i in range(300):
                await asyncio.sleep(1)
                
                if i % 3 == 0:
                    try:
                        pages = context.pages
                        if pages:
                            page = pages[0]
                            # Check if on Google Labs and logged in
                            if "labs.google" in page.url:
                                res = await page.evaluate('''async () => {
                                    try {
                                        const r = await fetch("/fx/api/auth/session");
                                        if (r.ok) return await r.json();
                                        return null;
                                    } catch(e) { return null; }
                                }''')
                                if res and res.get("user") and res["user"].get("email"):
                                    logged_in = True
                                    break
                    except Exception:
                        pass
            
            if not logged_in:
                log.error("Login timeout or failed for new account")
                try:
                    chrome_proc.terminate()
                except Exception:
                    pass
                await pw.stop()
                return None
            
            # Extract email from session
            page = context.pages[0]
            session_data = await page.evaluate('''async () => {
                const r = await fetch("/fx/api/auth/session");
                return await r.json();
            }''')
            
            email = session_data.get("user", {}).get("email")
            if not email:
                log.error("Could not extract email from session")
                try:
                    chrome_proc.terminate()
                except Exception:
                    pass
                await pw.stop()
                return None
            
            log.info(f"Successfully logged in as {email}")
            
            # ── Auto-detect tier from Google Labs page ──
            detected_tier = "FREE"  # Default to FREE
            try:
                tier_info = await page.evaluate('''() => {
                    const text = document.body.innerText;
                    // Check for ULTRA badge
                    if (/ULTRA/i.test(text)) return "ULTRA";
                    // Check for paid tiers
                    if (/AI Premium/i.test(text)) return "ULTRA";
                    if (/AI trial/i.test(text)) return "FREE";
                    if (/FREE/i.test(text)) return "FREE";
                    return null;
                }''')
                if tier_info:
                    detected_tier = tier_info
                    log.info(f"Detected tier for {email}: {detected_tier}")
                else:
                    log.warning(f"Could not detect tier for {email}, defaulting to FREE")
            except Exception as e:
                log.warning(f"Tier detection error: {e}, defaulting to FREE")
            
            # Auto-detect credits
            detected_credits = 0
            try:
                credit_val = await page.evaluate(r'''() => {
                    const text = document.body.innerText;
                    const patterns = [
                        /(\d[\d,.\s]*)\s*Tín\s*dụng\s*AI/i,
                        /(\d[\d,.\s]*)\s*AI\s*credits?/i,
                        /(\d[\d,.\s]*)\s*credits?/i,
                    ];
                    for (const p of patterns) {
                        const m = text.match(p);
                        if (m) return parseInt(m[1].replace(/[,.\s]/g, ''));
                    }
                    return null;
                }''')
                if credit_val and credit_val > 0:
                    detected_credits = credit_val
                    log.info(f"Detected credits for {email}: {detected_credits}")
            except Exception:
                pass
            
            # Check if account already exists
            existing = next((a for a in self._account_mgr._accounts if a.email == email), None)
            if existing:
                log.info(f"Account {email} already exists, updating...")
                acc = existing
                acc.tier = detected_tier
                if detected_credits > 0:
                    acc.credit = detected_credits
            else:
                from account_manager import GoogleAccount
                acc = GoogleAccount(
                    id=int(uuid.uuid4().int % 1000000),
                    email=email,
                    tier=detected_tier,
                    cookie_path="",
                    status="active"
                )
                if detected_credits > 0:
                    acc.credit = detected_credits
                self._account_mgr._accounts.append(acc)
            
            await self._export_cookies(acc, context)
            
            try:
                chrome_proc.terminate()
            except Exception:
                pass
            await pw.stop()
            
            # Cleanup temp profile
            try:
                import shutil
                shutil.rmtree(str(user_data_dir), ignore_errors=True)
            except Exception:
                pass
            
            return acc
            
        except Exception as e:
            log.error(f"Error during new account login: {e}")
            try:
                chrome_proc.terminate()
            except Exception:
                pass
            if pw:
                try:
                    await pw.stop()
                except Exception:
                    pass
            return None

    @staticmethod
    def _find_free_port() -> int:
        """Find a free TCP port for Chrome DevTools Protocol."""
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(('', 0))
            return s.getsockname()[1]

