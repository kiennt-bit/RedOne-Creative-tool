"""BridgeFlowClient — FlowClient that routes ALL Google calls through
the Chrome extension bridge instead of Playwright.

Why
===
A request fired by Playwright is "from a freshly-spun, never-used-before
Chromium under automation control" — Google's bot detector picks up on
this and starts handing out 403 on reCAPTCHA tokens. Once flagged, the
same browser context gets 403 for ~10-15 minutes.

A request fired from inside the user's REAL Chrome (via the extension's
`chrome.scripting.executeScript({world: 'MAIN'})` + `fetch(url, {credentials: 'include'})`)
carries:
  - the user's real session cookies
  - the user's real browser fingerprint
  - tab history Google has seen interactively for hours

→ Google treats the call as "user did something" not "bot ran a script".
403s drop to near-zero (the G-Labs approach proven in production).

Architecture
============
BridgeFlowClient subclasses FlowClient and overrides ONLY the methods
that touch Playwright internals (`self._page.evaluate(...)`,
`self._page.request.post(...)`, etc.). The high-level methods
(`generate_video`, `upload_image`, `wait_for_completion`, etc.) stay
inherited unchanged because they build their payloads + call
`_browser_sandbox_request()` — which we now route through the bridge.

This keeps the public API 100% identical to FlowClient so routers
(content.py, image.py, long_video.py) don't need to know which client
they got.
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Optional

from .flow_client import (
    FlowClient,
    SessionDeadError,
)
from ..config import (
    AISANDBOX_BASE,
    X_CLIENT_DATA,
    X_BROWSER_VALIDATION,
    MAX_RETRY_COUNT,
)
from .browser_bridge import bridge, BridgeExtensionOfflineError, BridgeTimeoutError

log = logging.getLogger("redone.flow_bridge")


def _map_flow_tier(paygate: Optional[str], service: Optional[str],
                   sku: Optional[str]) -> str:
    """Map Google Flow /v1/credits tier fields → friendly label.

    `userPaygateTier` is the clearest ladder: TIER_TWO = Google AI Ultra,
    TIER_ONE = Google AI Pro, else (TIER_ZERO/UNSPECIFIED/missing) = Free.
    Confirmed on a real ULTRA account (2026-06): userPaygateTier=
    PAYGATE_TIER_TWO, serviceTier=SERVICE_TIER_ADVANCED, sku=G1_TIER2.
    serviceTier/sku are only used as a fallback when paygate is absent.
    """
    pg = (paygate or "").upper()
    sv = (service or "").upper()
    sk = (sku or "").upper()
    if "TIER_TWO" in pg:
        return "ULTRA"
    if "TIER_ONE" in pg:
        return "PRO"
    if pg:                       # any other explicit paygate value = free
        return "FREE"
    # Fallback when userPaygateTier missing — infer from serviceTier / sku.
    if "ADVANCED" in sv or "TIER2" in sk:
        return "ULTRA"
    if "PRO" in sv or "TIER1" in sk:
        return "PRO"
    return "FREE"


class BridgeFlowClient(FlowClient):
    """FlowClient variant where every Google call goes through the
    Chrome extension bridge. See module docstring for rationale.

    Public API matches FlowClient exactly — drop-in replacement.
    """

    def __init__(self, page=None, cookie_path: str = "", account_email: str = ""):
        # We pass page=None to the parent; everything that touches
        # self._page is overridden in this subclass.
        super().__init__(page=None, cookie_path=cookie_path, account_email=account_email)
        # Cache last-known user agent for use in headers (bridge fills it
        # in from the real Chrome on first proxy_fetch — until then we
        # use a sensible default).
        self._ua = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
        )

    # ── Auth / token ────────────────────────────────────────────────

    async def _do_get_token(self):
        """Fetch `ya29.*` Bearer token via the extension. The /fx/api/auth/session
        endpoint is same-origin with labs.google (the user's tab), so the
        proxy_fetch carries valid cookies and returns the NextAuth session.

        A `status == 0` reply means the extension couldn't even run the fetch —
        almost always because the labs.google tab was momentarily not found
        (Chrome discarded it via Memory Saver, it was navigating/redirecting,
        or the MV3 service worker had just woken). That's TRANSIENT, so we
        retry a few times before declaring the session dead — otherwise a
        split-second blip disables the account + pops the red banner even
        though the user IS logged in (the "thi thoảng Session hết hạn" bug).
        """
        log.info(f"[{self._account_email}] (bridge) fetching NextAuth session...")
        attempts = 3
        for attempt in range(1, attempts + 1):
            try:
                r = await bridge.proxy_fetch(
                    url="https://labs.google/fx/api/auth/session",
                    method="GET",
                    headers={"Accept": "application/json"},
                    response_mode="json",
                    timeout_ms=15000,
                )
            except BridgeExtensionOfflineError as e:
                raise SessionDeadError(self._account_email, str(e))

            status = r.get("status", 0)
            body = r.get("body")
            err = r.get("error")

            log.info(
                f"[{self._account_email}] (bridge) auth/session response "
                f"(attempt {attempt}/{attempts}): status={status} error={err!r} "
                f"body_type={type(body).__name__} body_preview={str(body)[:200]!r}"
            )

            if status == 200 and isinstance(body, dict) and body.get("access_token"):
                self._token = body["access_token"]
                log.info(f"[{self._account_email}] (bridge) got token ya29...{self._token[-8:]}")
                return

            # status=0 → extension couldn't fetch (labs.google tab momentarily
            # missing/discarded/navigating). TRANSIENT → wait + retry.
            if status == 0 and attempt < attempts:
                log.warning(
                    f"[{self._account_email}] (bridge) auth/session transient "
                    f"(status=0, {err or 'no detail'}) — retry {attempt}/{attempts}…"
                )
                await asyncio.sleep(1.0 * attempt)
                continue
            if status == 0:
                raise SessionDeadError(
                    self._account_email,
                    f"Extension không fetch được /fx/api/auth/session ({err or 'no detail'}) "
                    f"sau {attempts} lần thử. Kiểm tra: chrome://extensions có 'RedOne Auth Helper' "
                    "+ popup 3 dòng xanh + tab labs.google/fx đang mở, đã đăng nhập, và ĐỪNG để "
                    "Chrome 'ngủ' (discard) tab đó.",
                )

            # 200 OK but no access_token = page returned but user signed out.
            # 404 = labs.google has no NextAuth session for current Chrome user.
            # These are NOT transient → fail fast.
            if status == 404 or (status == 200 and not (isinstance(body, dict) and body.get("access_token"))):
                raise SessionDeadError(
                    self._account_email,
                    "Chưa đăng nhập Google trong Chrome thật (không phải Cloak). "
                    "Mở tab https://labs.google/fx/tools/flow trong Chrome thật, "
                    "click Sign in, chọn account Google. Sau đó retry task.",
                )

            log.error(f"[{self._account_email}] (bridge) token fetch failed: HTTP {status} {body}")
            raise SessionDeadError(
                self._account_email,
                f"Không lấy được session token (HTTP {status}, error: {err}). Login lại trong Chrome.",
            )

    async def renew_token(self):
        """Force a fresh /fx/api/auth/session. No page reload needed —
        cookies live in user's Chrome, not in our state."""
        log.info(f"[{self._account_email}] (bridge) renewing token...")
        self._token = None
        await self.ensure_token()

    # ── Sandbox HTTP calls (route via bridge) ───────────────────────

    async def _browser_sandbox_request(
        self, endpoint: str, payload: dict, is_text_plain: bool = False,
    ) -> dict:
        """Replacement for the Playwright-based version. Calls
        aisandbox-pa endpoint via bridge.proxy_fetch — runs inside the
        user's labs.google tab so cookies + fingerprint are real.
        """
        await self.ensure_token()
        token = self._token or ""
        url = f"{AISANDBOX_BASE}/{endpoint.lstrip('/')}"
        body_json = json.dumps(payload, ensure_ascii=False)

        ct = "text/plain;charset=UTF-8" if is_text_plain else "application/json"
        for attempt in range(1, MAX_RETRY_COUNT + 1):
            try:
                # Match the original Playwright _browser_sandbox_request JS
                # exactly: ONLY Authorization + Content-Type. Adding x-client-data
                # or x-browser-validation triggers an additional CORS preflight
                # header check that aisandbox-pa rejects → "Failed to fetch".
                # The browser context (labs.google tab) supplies its own
                # x-client-data when needed via Chrome's network stack.
                r = await bridge.proxy_fetch(
                    url=url,
                    method="POST",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": ct,
                    },
                    body=body_json,
                    response_mode="json",
                    timeout_ms=120000,
                )
            except BridgeExtensionOfflineError as e:
                return {"error": str(e)}
            except BridgeTimeoutError as e:
                log.warning(f"(bridge) {endpoint} attempt {attempt} timeout: {e}")
                if attempt < MAX_RETRY_COUNT:
                    await asyncio.sleep(2 * attempt)
                    continue
                return {"error": str(e)}

            if r.get("error"):
                log.warning(f"(bridge) {endpoint} attempt {attempt}: {r['error']}")
                if attempt < MAX_RETRY_COUNT:
                    await asyncio.sleep(2 * attempt)
                    continue
                return {"error": r["error"]}

            status = r.get("status", 0)

            # 401/403 → renew token and retry. After max retries on 401,
            # session is dead.
            if status in (401, 403) and attempt < MAX_RETRY_COUNT:
                body = r.get("body")
                err_text = ""
                if isinstance(body, dict):
                    err_text = json.dumps(body, ensure_ascii=False)[:200]
                elif isinstance(body, str):
                    err_text = body[:200]
                else:
                    err_text = r.get("body_text", "")[:200]
                log.warning(f"(bridge) {endpoint}: HTTP {status}: {err_text[:100]}")
                # reCAPTCHA-flavored 403 — don't bother renewing token,
                # surface the error so circuit breaker can handle.
                low = err_text.lower()
                if "recaptcha" in low or "unusual_activity" in low:
                    return {"error": f"HTTP {status}", "text": err_text}
                try:
                    await self.renew_token()
                except SessionDeadError:
                    raise
                token = self._token or ""
                await asyncio.sleep(1)
                continue

            # Persistent 401 → session dead
            if status == 401 and attempt >= MAX_RETRY_COUNT:
                body = r.get("body")
                err_text = json.dumps(body)[:200] if isinstance(body, dict) else str(body)[:200]
                low = err_text.lower()
                if "missing required authentication" in low or "unauthenticated" in low:
                    raise SessionDeadError(
                        self._account_email,
                        "Google trả 401 nhiều lần — session chết, login lại.",
                    )

            if 200 <= status < 300:
                body = r.get("body")
                if isinstance(body, dict):
                    return body
                # Body was returned as plain text (not JSON) — caller
                # expecting dict gets back wrapped text for them to handle.
                return {"text": (r.get("body_text") or "")[:2000]}

            # Other HTTP errors
            body = r.get("body")
            err_text = json.dumps(body)[:300] if isinstance(body, dict) else (
                r.get("body_text") or str(body)
            )[:300]
            log.warning(f"(bridge) {endpoint} HTTP {status}: {err_text}")
            if attempt < MAX_RETRY_COUNT and status >= 500:
                await asyncio.sleep(2 * attempt)
                continue
            return {"error": f"HTTP {status}", "text": err_text}

        return {"error": "Max retries exceeded"}

    async def _sandbox_request(
        self, endpoint: str, payload, method: str = "POST",
    ) -> dict:
        """Same as _browser_sandbox_request — historically the Playwright
        FlowClient had two paths (httpx + browser fetch), but with the
        bridge everything goes through the user's tab."""
        if not isinstance(payload, (str, bytes)):
            payload_dict = payload if isinstance(payload, dict) else {}
        else:
            try:
                payload_dict = json.loads(payload)
            except Exception:
                payload_dict = {}
        return await self._browser_sandbox_request(endpoint, payload_dict)

    # ── reCAPTCHA via bridge ────────────────────────────────────────

    async def get_recaptcha_token(self, action: str = "VIDEO_GENERATION") -> str:
        """Harvest reCAPTCHA token from the user's real Chrome (the win:
        Google scores this token like a real human action because it
        comes from a long-lived, real-fingerprint browser).
        """
        log.info(f"[{self._account_email}] (bridge) harvesting reCAPTCHA action={action}...")
        try:
            token = await bridge.harvest_recaptcha(site_key="", action=action)
        except BridgeExtensionOfflineError as e:
            log.warning(f"(bridge) reCAPTCHA: {e}")
            return ""
        except (BridgeTimeoutError, RuntimeError) as e:
            log.warning(f"(bridge) reCAPTCHA harvest failed: {e}")
            self._recaptcha_fail_count += 1
            return ""
        log.info(f"[{self._account_email}] (bridge) got token: {token[:20]}...")
        self._recaptcha_fail_count = 0
        return token

    # ── tRPC API (via bridge) ───────────────────────────────────────

    async def _api(self, procedure: str, payload, method: str = "POST") -> dict:
        """tRPC API — also via bridge so cookies are valid for
        labs.google domain."""
        await self.ensure_token()
        token = self._token or ""
        # tRPC is on labs.google (same-origin from labs.google tab) so
        # we can keep cookies + minimal headers. No x-client-data etc.
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        try:
            if method.upper() == "GET":
                import urllib.parse
                inp = json.dumps({"json": payload})
                url = f"{self.TRPC}/{procedure}?input={urllib.parse.quote(inp)}"
                r = await bridge.proxy_fetch(
                    url=url, method="GET", headers=headers,
                    response_mode="json", timeout_ms=30000,
                )
            else:
                url = f"{self.TRPC}/{procedure}"
                body = json.dumps({"json": payload})
                r = await bridge.proxy_fetch(
                    url=url, method="POST", headers=headers, body=body,
                    response_mode="json", timeout_ms=30000,
                )
            status = r.get("status", 0)
            body = r.get("body")
            if 200 <= status < 300 and isinstance(body, dict):
                return body
            return {"error": status, "text": (r.get("body_text") or "")[:500]}
        except Exception as e:
            return {"error": str(e)}

    # ── Credits check ──────────────────────────────────────────────

    async def check_credits(self) -> Optional[dict]:
        """Hit /v1/credits via bridge and return {"remainingCredits": N}.

        IMPORTANT: must return the SAME shape as the Playwright FlowClient
        (`{"remainingCredits": <int>}`), because check_account() looks for
        that exact key. The raw Google response uses `subscriptionCredits` /
        `topUpCredits` / `credits` instead — returning it unparsed (the old
        bug) made check_account never find `remainingCredits`, so the credit
        column never updated on the accounts page even though gen worked.

        We prefer `subscriptionCredits` (the "Tín dụng Flow" number Google
        shows in the avatar popup), falling back to total `credits`.
        """
        await self.ensure_token()
        token = self._token or ""
        try:
            r = await bridge.proxy_fetch(
                url=f"{AISANDBOX_BASE}/credits",
                method="GET",
                headers={"Authorization": f"Bearer {token}"},
                response_mode="json",
                timeout_ms=20000,
            )
            status = r.get("status")
            body = r.get("body")
            if status == 200 and isinstance(body, dict):
                val = body.get("subscriptionCredits")
                if not isinstance(val, (int, float)):
                    val = body.get("credits")
                if isinstance(val, (int, float)):
                    tier = _map_flow_tier(
                        body.get("userPaygateTier"),
                        body.get("serviceTier"),
                        body.get("sku"),
                    )
                    return {"remainingCredits": int(val), "tier": tier}
                log.warning(
                    f"(bridge) check_credits: no credit field in body "
                    f"keys={list(body.keys())}"
                )
                return {"error": "Không tìm thấy số credit trong response Google"}
            log.warning(f"(bridge) check_credits: HTTP {status} {r.get('error')}")
            return {"error": f"HTTP {status}"} if status else None
        except Exception as e:
            log.error(f"(bridge) check_credits error: {e}")
            return {"error": str(e)}

    # ── Binary downloads ───────────────────────────────────────────

    async def _fetch_mp4_via_browser(self, media_id: str) -> Optional[bytes]:
        """Fetch generated video bytes via bridge — runs inside the
        user's labs.google tab so the 307 redirect to flow-content.google
        gets authenticated via session cookies automatically.

        URL format matches the original Playwright FlowClient EXACTLY:
            /fx/api/trpc/media.getMediaUrlRedirect?name=<media_id>
        (NOT `?input={"json":{"mediaId":...}}` — that's wrong format
        and returns 400.)

        Browser fetch follows the 307 redirect automatically, so we
        receive the CDN video bytes directly.
        """
        url = f"{self.TRPC}/media.getMediaUrlRedirect?name={media_id}"
        try:
            status, body, _ = await bridge.proxy_fetch_binary(
                url=url,
                method="GET",
                # No headers needed — same-origin from labs.google tab,
                # cookies attach automatically. Bearer token NOT required
                # for this endpoint (session cookies authenticate).
                timeout_ms=300000,  # videos can be big
            )
            if status == 200 and body and len(body) > 100_000:
                log.info(f"(bridge) _fetch_mp4_via_browser OK: {len(body)} bytes")
                return body
            log.warning(f"(bridge) _fetch_mp4_via_browser: status={status}, size={len(body) if body else 0}")
            return None
        except Exception as e:
            log.error(f"(bridge) _fetch_mp4_via_browser error: {e}")
            return None

    async def get_download_url(self, media_id: str) -> Optional[str]:
        """Override — original uses self._page.request which is None in
        bridge mode. Bridge fetch follows redirects automatically and we
        can't read Location header from a cross-origin 307 via JS fetch
        (CORS blocks header access on opaqueredirect responses), so we
        skip this fallback path. _fetch_mp4_via_browser handles download
        directly anyway.
        """
        log.debug(f"(bridge) get_download_url skipped (bridge mode uses direct fetch)")
        return None

    async def download_video(self, url: str, output_path: str) -> bool:
        """Download mp4 from a signed URL via bridge (preserves cookies
        for any subsequent auth redirect)."""
        if not url:
            return False
        try:
            status, body, _ = await bridge.proxy_fetch_binary(
                url=url, method="GET", timeout_ms=300000,
            )
            if status == 200 and body and len(body) > 100_000:
                Path(output_path).parent.mkdir(parents=True, exist_ok=True)
                Path(output_path).write_bytes(body)
                log.info(f"(bridge) Downloaded video: {output_path} ({len(body)} bytes)")
                return True
            log.warning(f"(bridge) download_video: status={status}, size={len(body) if body else 0}")
            return False
        except Exception as e:
            log.error(f"(bridge) download_video error: {e}")
            return False

    async def download_image(self, url: str, output_path: str) -> bool:
        """Download generated image from URL via bridge."""
        if not url:
            return False
        try:
            status, body, _ = await bridge.proxy_fetch_binary(
                url=url, method="GET", timeout_ms=60000,
            )
            if status == 200 and body and len(body) > 100:
                Path(output_path).parent.mkdir(parents=True, exist_ok=True)
                Path(output_path).write_bytes(body)
                log.info(f"(bridge) Downloaded image: {output_path} ({len(body)} bytes)")
                return True
            log.warning(f"(bridge) download_image: status={status}, size={len(body) if body else 0}")
            return False
        except Exception as e:
            log.error(f"(bridge) download_image error: {e}")
            return False

    # ── Lifecycle ──────────────────────────────────────────────────

    async def close(self) -> None:
        """No-op — bridge is a shared module-level singleton, nothing
        to dispose per-client."""
        return
