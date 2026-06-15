"""Per-task circuit breaker for Google reCAPTCHA 403 cascades.

The pattern Google's API uses: once it flags a browser session as bot-y,
EVERY subsequent reCAPTCHA token from that session is rejected. Just
reloading the page (renew_token) doesn't reset Google's risk score —
that needs ~10-15 minutes of inactivity. Without protection, all the
items in a single task burn through their inner retry budget against
a session that won't recover, wasting credits + wall-clock time.

Usage (one CircuitBreaker per task — NOT module-global):

    circuit = CircuitBreaker(threshold=3)

    async def _process_one(item):
        async with semaphore:
            if await circuit.is_open():
                # Mark this item as skipped, don't even try the API
                mark_error(item, "Skipped — Google reCAPTCHA cooldown")
                return
            try:
                await client.generate_video(...)
                await circuit.record_success()
            except Exception as ex:
                tripped_now = await circuit.record_failure(str(ex))
                if tripped_now:
                    await hub.broadcast("task_circuit_tripped", ...)
                mark_error(item, str(ex))

The breaker only counts reCAPTCHA-flavored failures (403 / permission
denied / unusual_activity / recaptcha) — other failures (network glitch,
Google internal error, etc.) reset the counter back to 0 so a transient
hiccup doesn't trip the circuit.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Iterable

log = logging.getLogger("redone.circuit_breaker")


# Substrings that indicate Google detected automation, OR a side-effect of
# the renew_token() page reload triggered by such an event. Lowercased.
RECAPTCHA_ERROR_PATTERNS: tuple[str, ...] = (
    "403",
    "recaptcha",
    "permission_denied",
    "unusual_activity",
    # ── Page-reload byproducts (caused by 403 → renew_token chain) ──
    # When a 403 fires for ANY in-flight call, the FlowClient renews the
    # session by reloading the browser page. Other concurrent calls on
    # that same page then explode with these specific Playwright errors:
    "execution context was destroyed",
    "failed to fetch",
    # Counting them as captcha-flavored makes the circuit trip faster on
    # the user's machine (otherwise the counter ping-pongs and never
    # reaches the threshold — observed in logs 2026-05-22).
)


def is_recaptcha_error(err: str) -> bool:
    """True if the error message looks like Google's "we think you're a bot"
    response (or a direct side-effect of our 403 retry path)."""
    if not err:
        return False
    err_lc = err.lower()
    return any(p in err_lc for p in RECAPTCHA_ERROR_PATTERNS)


class CircuitBreaker:
    """Counts consecutive reCAPTCHA failures. Trips after `threshold`,
    stays open until the task ends. Async-safe via internal lock.

    Lifecycle is one-per-task — when the task finishes, the CircuitBreaker
    is garbage-collected. A fresh task starts with a fresh counter.
    """

    def __init__(self, threshold: int = 3):
        self.threshold = threshold
        self._consecutive = 0
        self._open = False
        self._lock = asyncio.Lock()

    async def is_open(self) -> bool:
        async with self._lock:
            return self._open

    @property
    def consecutive(self) -> int:
        """Best-effort snapshot for logging — not locked."""
        return self._consecutive

    async def record_failure(self, error_msg: str) -> bool:
        """Update state for a failed item. Returns True only on the
        transition from closed → open (so the caller can broadcast a
        one-shot warning event).

        Non-Captcha errors (timeout, bad prompt, model unavailable, etc.)
        are IGNORED — they neither increment nor reset the counter. This
        matches user intent: "chỉ lỗi 403 thì mới áp dụng kiểu skip hết
        các video còn lại". A previous version reset the counter on any
        non-Captcha error which caused the circuit to never trip when
        403-induced "Execution context destroyed" errors kept ping-
        ponging the counter back to zero.
        """
        if not is_recaptcha_error(error_msg):
            # Don't touch the counter — circuit only tracks 403/captcha
            # failures. Unrelated errors are accounted at the item level
            # (status=ERROR) but don't affect the cascade detector.
            return False

        async with self._lock:
            self._consecutive += 1
            if self._consecutive >= self.threshold and not self._open:
                self._open = True
                log.warning(
                    f"Circuit OPENED after {self._consecutive} consecutive "
                    f"reCAPTCHA failures"
                )
                return True
        return False

    async def record_success(self) -> None:
        """Successful item — reset the consecutive counter. Doesn't
        un-open an already-tripped circuit (paranoid: a single success
        in a sea of failures doesn't mean Google has un-flagged us)."""
        async with self._lock:
            self._consecutive = 0
