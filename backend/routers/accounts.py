"""Account management endpoints."""
from __future__ import annotations
import asyncio
import json
import logging
import os
import socket
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel

from ..database import db
from ..config import COOKIES_DIR, DATA_DIR
from ..ws_hub import hub

log = logging.getLogger("navtools.accounts")
router = APIRouter(prefix="/api/accounts", tags=["accounts"])

PROFILE_DIR = DATA_DIR / "browser_profiles"
PROFILE_DIR.mkdir(parents=True, exist_ok=True)


class AddAccount(BaseModel):
    email: str


@router.get("")
async def list_accounts():
    return {"accounts": db.get_accounts()}


@router.post("")
async def add_account(body: AddAccount):
    if not body.email or "@" not in body.email:
        raise HTTPException(400, "Invalid email")
    acc_id = db.add_account(body.email.strip().lower())
    await hub.broadcast("account_added", {"id": acc_id, "email": body.email})
    return {"id": acc_id, "email": body.email}


@router.delete("/{account_id}")
async def delete_account(account_id: int):
    db.delete_account(account_id)
    await hub.broadcast("account_deleted", {"id": account_id})
    return {"ok": True}


@router.post("/{account_id}/toggle")
async def toggle_account(account_id: int):
    acc = db.get_account(account_id)
    if not acc:
        raise HTTPException(404, "Account not found")
    new_state = 0 if acc["enabled"] else 1
    db.update_account(account_id, enabled=new_state)
    await hub.broadcast("account_updated", {"id": account_id, "enabled": bool(new_state)})
    return {"ok": True, "enabled": bool(new_state)}


@router.post("/{account_id}/cookie")
async def upload_cookie(account_id: int, file: UploadFile = File(...)):
    acc = db.get_account(account_id)
    if not acc:
        raise HTTPException(404, "Account not found")
    raw = await file.read()
    try:
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, list):
            raise ValueError("Cookie JSON must be a list")
    except Exception as e:
        raise HTTPException(400, f"Invalid cookie JSON: {e}")
    cookie_path = COOKIES_DIR / f"{account_id}_cookies.json"
    cookie_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    db.update_account(account_id, cookie_path=str(cookie_path))
    await hub.broadcast("account_updated", {"id": account_id})
    return {"ok": True, "cookie_path": str(cookie_path)}


@router.post("/{account_id}/check")
async def check_account(account_id: int):
    """Check session validity + credits via Playwright."""
    acc = db.get_account(account_id)
    if not acc:
        raise HTTPException(404, "Account not found")
    if not acc.get("cookie_path") or not Path(acc["cookie_path"]).exists():
        return {"ok": False, "reason": "no_cookies", "message": "Account chưa có cookies"}

    try:
        from ..services import browser_manager as bm_mod, flow_client as fc_mod
        bm = bm_mod.BrowserManager()
        page = await bm.get_page(
            account_id=account_id,
            email=acc["email"],
            cookie_path=acc["cookie_path"],
            url="https://labs.google/fx/tools/video-fx",
        )
        # Wait for page to settle
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=15000)
        except Exception:
            pass
        # If redirected to signin → session dead
        alive = "accounts.google.com" not in (page.url or "")
        credit = None
        if alive:
            client = fc_mod.FlowClient(
                page, cookie_path=acc["cookie_path"], account_email=acc["email"],
            )
            try:
                info = await client.check_credits()
                if isinstance(info, dict):
                    credit = info.get("remainingCredits")
            except Exception as e:
                log.warning(f"check_credits failed: {e}")

        update_fields = {}
        if credit is not None:
            update_fields["credit"] = int(credit)
        if update_fields:
            db.update_account(account_id, **update_fields)
        await hub.broadcast("account_updated", {"id": account_id, "credit": credit, "alive": alive})
        return {"ok": True, "alive": alive, "credit": credit}
    except Exception as e:
        log.exception(f"check_account failed for {account_id}")
        return {"ok": False, "reason": "error", "message": str(e)}


@router.post("/check-all")
async def check_all_accounts():
    accounts = db.get_accounts()
    results = []
    for acc in accounts:
        try:
            r = await check_account(acc["id"])
            results.append({"id": acc["id"], **(r if isinstance(r, dict) else {})})
        except Exception as e:
            results.append({"id": acc["id"], "ok": False, "message": str(e)})
    return {"results": results}


# ─────────────────────────────────────────────────────────────
# Login flow: launch REAL Chrome (visible) → user signs in →
# we monitor via CDP and export cookies on success.
# ─────────────────────────────────────────────────────────────

def _find_free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


async def _do_login(account_id: int, email: str) -> tuple[bool, str]:
    """Open visible Chrome → wait for sign-in → export cookies. Returns (ok, message)."""
    from playwright.async_api import async_playwright
    from ..services.browser_manager import find_chrome

    chrome_exe = find_chrome()
    if not chrome_exe:
        return False, "Không tìm thấy Chrome trên máy"

    profile_dir = (PROFILE_DIR / f"login_{account_id}").resolve()
    profile_dir.mkdir(parents=True, exist_ok=True)
    cookie_path = COOKIES_DIR / f"{account_id}_cookies.json"

    debug_port = _find_free_port()
    chrome_args = [
        chrome_exe,
        f"--remote-debugging-port={debug_port}",
        f"--user-data-dir={profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=900,720",
        "--window-position=120,80",
        # Land at Flow directly — Google sẽ tự redirect sang accounts.google.com
        # nếu chưa login; sau khi login xong sẽ tự về Flow → cookie cho labs.google
        # sẽ được set ngay.
        "https://labs.google/fx/tools/video-fx",
    ]
    log.info(f"[login {email}] Chrome CDP port={debug_port}, profile={profile_dir}")

    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    proc = subprocess.Popen(chrome_args, creationflags=creationflags)
    await asyncio.sleep(4)

    pw = None
    browser = None
    try:
        pw = await async_playwright().start()
        cdp_url = f"http://127.0.0.1:{debug_port}"
        for attempt in range(25):
            try:
                browser = await pw.chromium.connect_over_cdp(cdp_url)
                log.info(f"[login {email}] CDP connected on attempt {attempt + 1}")
                break
            except Exception as e:
                if attempt == 24:
                    log.error(f"CDP connect failed: {e}")
                await asyncio.sleep(0.5)
        if not browser:
            try: proc.terminate()
            except Exception: pass
            return False, "Không kết nối được Chrome qua CDP (profile có thể đang được mở bởi Chrome khác?)"

        context = browser.contexts[0] if browser.contexts else None
        if not context:
            try: proc.terminate()
            except Exception: pass
            return False, "Không tìm thấy context Chrome"

        log.info(f"[login {email}] Waiting for user to sign in & visit Flow (5 phút)...")

        # We poll cookies — the ONLY reliable signal that login is complete is
        # the presence of NextAuth session cookies on labs.google. Do NOT
        # auto-navigate the page — that breaks the OAuth callback (?code=XXX)
        # before NextAuth can set its session cookie.
        labs_session = False
        last_labs_cookie_count = 0
        stable_ticks = 0

        for tick in range(300):  # 5 min
            await asyncio.sleep(1)
            try:
                snap = await context.cookies()
                labs_cookies = [
                    c for c in snap
                    if "labs.google" in (c.get("domain") or "").lstrip(".")
                ]
                # Look specifically for NextAuth session token (final proof of login)
                has_session_token = any(
                    "next-auth.session-token" in (c.get("name") or "")
                    or "__Secure-next-auth.session-token" in (c.get("name") or "")
                    for c in labs_cookies
                )

                if has_session_token:
                    # Wait for the cookie count to stabilize (2 consecutive ticks
                    # with the same count) — Google may still be setting cookies
                    if len(labs_cookies) == last_labs_cookie_count and last_labs_cookie_count > 0:
                        stable_ticks += 1
                    else:
                        stable_ticks = 0
                    last_labs_cookie_count = len(labs_cookies)

                    if stable_ticks >= 2:
                        log.info(
                            f"[login {email}] NextAuth session ready "
                            f"({len(labs_cookies)} labs cookies stable for {stable_ticks}s)"
                        )
                        labs_session = True
                        break
            except Exception:
                pass

        if not labs_session:
            try: proc.terminate()
            except Exception: pass
            return False, (
                "Timeout 5 phút — chưa thấy session cookie cho labs.google.\n"
                "• Đã đăng nhập Google chưa?\n"
                "• Đã vào được app Flow (labs.google/fx/tools/video-fx) chưa?\n"
                "Nếu Flow yêu cầu 'Try Flow' / 'Get Started' → bấm vào để vào app, đợi 2-3s rồi mới đóng popup này."
            )

        # Export cookies — get final snapshot
        try:
            cookies = await context.cookies()
            sanitized = []
            for c in cookies:
                ck = {k: c[k] for k in ("name", "value", "domain", "path", "expires", "httpOnly", "secure", "sameSite") if k in c}
                sanitized.append(ck)
            cookie_path.write_text(
                json.dumps(sanitized, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
            labs_count = sum(1 for c in cookies if "labs.google" in (c.get("domain") or "")
                             or "google.com" == (c.get("domain") or "").lstrip("."))
            log.info(f"[login {email}] Exported {len(sanitized)} cookies ({labs_count} for labs/google.com) → {cookie_path}")

            max_exp = max((c.get("expires", 0) or 0 for c in cookies), default=0)
            cookie_exp = datetime.fromtimestamp(max_exp).isoformat() if max_exp > 0 else None
            db.update_account(
                account_id,
                cookie_path=str(cookie_path),
                **({"cookie_exp": cookie_exp} if cookie_exp else {}),
            )
        except Exception as e:
            log.error(f"Cookie export failed: {e}")
            try: proc.terminate()
            except Exception: pass
            return False, f"Login OK nhưng export cookie lỗi: {e}"

        try: proc.terminate()
        except Exception: pass
        return True, f"Đã lưu {len(sanitized)} cookies"
    finally:
        if pw:
            try: await pw.stop()
            except Exception: pass


async def _do_login_cloak(account_id: int, email: str) -> tuple[bool, str]:
    """Login flow using CloakBrowser stealth Chromium.

    Same UX as the Chrome flow: launches a visible window at the Flow URL,
    polls cookies until the labs.google NextAuth session token appears,
    then exports cookies and closes the browser.
    """
    try:
        from ..services.cloak_backend import is_available
        ok, err = is_available()
        if not ok:
            return False, f"CloakBrowser chưa cài: {err}. Cài: pip install cloakbrowser"
        from cloakbrowser import launch_persistent_context_async
    except Exception as e:
        return False, f"Không import được cloakbrowser: {e}"

    # Cloak uses its own persistent profile dir (separate from Chrome's
    # browser_profiles/login_{id})
    profile_dir = (PROFILE_DIR / "cloak_login" / str(account_id)).resolve()
    profile_dir.mkdir(parents=True, exist_ok=True)
    cookie_path = COOKIES_DIR / f"{account_id}_cookies.json"

    log.info(f"[login cloak {email}] launching CloakBrowser, profile={profile_dir}")

    context = None
    try:
        try:
            context = await launch_persistent_context_async(
                user_data_dir=str(profile_dir),
                headless=False,
                humanize=True,
                args=[
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--window-size=900,720",
                    "--window-position=120,80",
                ],
                viewport={"width": 900, "height": 720},
                locale="vi-VN",
            )
        except Exception as e:
            return False, (
                f"Không khởi động được CloakBrowser: {e}. "
                "Lần đầu cần internet để tải binary ~200MB."
            )

        # Open Flow page (will redirect to login if not authenticated)
        page = context.pages[0] if context.pages else await context.new_page()
        try:
            await page.goto("https://labs.google/fx/tools/video-fx",
                            wait_until="domcontentloaded", timeout=30000)
        except Exception:
            pass

        log.info(f"[login cloak {email}] waiting for NextAuth session (5 phút)...")

        labs_session = False
        last_count = 0
        stable_ticks = 0
        for tick in range(300):
            await asyncio.sleep(1)
            try:
                snap = await context.cookies()
                labs_cookies = [
                    c for c in snap
                    if "labs.google" in (c.get("domain") or "").lstrip(".")
                ]
                has_session = any(
                    "next-auth.session-token" in (c.get("name") or "")
                    or "__Secure-next-auth.session-token" in (c.get("name") or "")
                    for c in labs_cookies
                )
                if has_session:
                    if len(labs_cookies) == last_count and last_count > 0:
                        stable_ticks += 1
                    else:
                        stable_ticks = 0
                    last_count = len(labs_cookies)
                    if stable_ticks >= 2:
                        labs_session = True
                        break
            except Exception:
                pass

        if not labs_session:
            return False, (
                "Timeout 5 phút — chưa thấy session cookie cho labs.google.\n"
                "Hãy login Google trong cửa sổ CloakBrowser vừa hiện rồi vào lại Flow."
            )

        # Export cookies
        cookies = await context.cookies()
        sanitized = []
        for c in cookies:
            ck = {k: c[k] for k in ("name", "value", "domain", "path",
                                    "expires", "httpOnly", "secure", "sameSite") if k in c}
            sanitized.append(ck)
        cookie_path.write_text(
            json.dumps(sanitized, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        max_exp = max((c.get("expires", 0) or 0 for c in cookies), default=0)
        cookie_exp = datetime.fromtimestamp(max_exp).isoformat() if max_exp > 0 else None
        db.update_account(
            account_id,
            cookie_path=str(cookie_path),
            **({"cookie_exp": cookie_exp} if cookie_exp else {}),
        )
        log.info(f"[login cloak {email}] exported {len(sanitized)} cookies → {cookie_path}")
        return True, f"Đã lưu {len(sanitized)} cookies (CloakBrowser)"
    finally:
        if context is not None:
            try: await context.close()
            except Exception: pass


def _which_backend() -> str:
    """Read browser_backend setting; default 'chrome'."""
    val = db.get_setting("browser_backend", "chrome")
    if isinstance(val, str) and val.lower() in ("chrome", "cloak"):
        return val.lower()
    return "chrome"


@router.post("/{account_id}/login")
async def login_account(account_id: int):
    acc = db.get_account(account_id)
    if not acc:
        raise HTTPException(404, "Account not found")
    try:
        if _which_backend() == "cloak":
            ok, msg = await _do_login_cloak(account_id, acc["email"])
        else:
            ok, msg = await _do_login(account_id, acc["email"])
        if ok:
            await hub.broadcast("account_updated", {"id": account_id})
        return {"ok": ok, "message": msg}
    except Exception as e:
        log.exception("Login crashed")
        raise HTTPException(500, f"Login crashed: {e}")
