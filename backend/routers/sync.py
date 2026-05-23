"""Bridge endpoints between RedOne backend and the Chrome extension.

The extension polls these endpoints to pick up tasks the backend wants
performed inside the user's real Chrome (the win: requests originate from
the same browser fingerprint Google has been serving normally, so
reCAPTCHA scores stay high + 403 cascades dry up).

Protocol summary:

    GET  /sync/status                       heartbeat / ping
    GET  /sync/next-task?tab_status=...     extension polls for next task
    POST /sync/task-result                  extension submits result

Payload envelope: `{ "d": "<hex>" }` where the inner JSON is XOR'd byte-by-byte
with 0x5A. Lightweight obfuscation only — NOT security. Matches G-Labs's
protocol so we can reuse their patterns if needed.

Tasks supported:
    - "recaptcha":     site_key + action → token
    - "proxy_fetch":   url + method + headers + body → {status, headers, body}

Tasks are produced by `BrowserBridge.harvest_recaptcha()` /
`BrowserBridge.proxy_fetch()` (see services/browser_bridge.py). Each task
lives in the queue until either the extension picks it up + posts a result,
or it expires after `TASK_TTL_S`.
"""
from __future__ import annotations
import json
import logging
import time
from typing import Optional, Any
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

log = logging.getLogger("redone.sync")
router = APIRouter(prefix="/sync", tags=["sync-bridge"])


XOR_KEY = 0x5A
TASK_TTL_S = 120.0


# ── XOR codec (parity with extension/background.js) ─────────────────

def xor_encode(plaintext: str) -> str:
    """Encode a string as hex, each byte XOR'd with XOR_KEY.

    To stay compatible with the extension's JS encoder, non-ASCII chars
    are first escaped as `\\uXXXX` sequences so we only XOR over a
    well-defined byte stream.
    """
    out_chars: list[str] = []
    for ch in plaintext:
        code = ord(ch)
        if code < 0x20 or code > 0x7E:
            out_chars.append("\\u" + format(code, "04x"))
        else:
            out_chars.append(ch)
    ascii_str = "".join(out_chars)
    return "".join(format(ord(c) ^ XOR_KEY, "02x") for c in ascii_str)


def xor_decode(hex_string: str) -> str:
    """Reverse of `xor_encode`. The `\\uXXXX` escapes are left as-is in
    the result — JSON parsers handle them natively."""
    result_chars: list[str] = []
    for i in range(0, len(hex_string), 2):
        byte = int(hex_string[i:i + 2], 16) ^ XOR_KEY
        result_chars.append(chr(byte))
    return "".join(result_chars)


def envelope(payload: dict) -> dict:
    """Wrap a payload in `{d: <xor-hex>}` envelope for sending to the
    extension. The extension's decoder pulls `d`, decodes it, and
    `JSON.parse`s the result."""
    return {"d": xor_encode(json.dumps(payload, ensure_ascii=True))}


def unwrap(raw: Any) -> dict:
    """Inverse of envelope — accepts either an envelope dict
    `{d: <hex>}` or a plain dict and returns the inner payload."""
    if isinstance(raw, dict) and isinstance(raw.get("d"), str):
        decoded = xor_decode(raw["d"])
        return json.loads(decoded)
    if isinstance(raw, dict):
        return raw
    raise ValueError("expected JSON object or envelope dict")


# ── Endpoints ────────────────────────────────────────────────────────

@router.get("/status")
async def status():
    """Heartbeat — extension hits this every ~15s to keep its connection
    indicator green. Also useful for backend → extension liveness checks
    via the ext popup's metrics display.

    IMPORTANT: also bumps `_ext_last_poll` so the bridge's
    `is_extension_live()` check stays True even when the ext is busy
    running a long proxy_fetch (during which it doesn't hit
    /sync/next-task). Without this, large file uploads would falsely
    trip "Extension offline" on concurrent tasks.
    """
    from ..services.browser_bridge import bridge
    # Don't overwrite tab_status here — we don't know it. Just mark live.
    bridge.bump_liveness()
    return {"ok": True, "ts": time.time(), "service": "redone-bridge"}


class TaskResultBody(BaseModel):
    # Envelope-wrapped or plain — we accept both for flexibility.
    d: Optional[str] = None
    task_id: Optional[str] = None
    kind: Optional[str] = None
    result: Optional[dict] = None


@router.get("/next-task")
async def next_task(
    tab_status: str = "ready",
    tab_url: str = "",
):
    """Extension long-polls (well, short-polls — every ~1.5s) for the
    next task to run. Returns `{task: null}` if the queue is empty.

    The `tab_status` query string is the extension reporting back what
    it can currently do:
        - "ready"     — at least one labs.google tab is open and signed in
        - "no_tab"    — no labs.google tab open
        - "no_login"  — tab is open but user isn't signed into Google

    Backend tracks the last-seen tab status so other routers (accounts,
    settings) can show a meaningful "Extension is offline / no tab open"
    banner without needing to poll the extension themselves.
    """
    from ..services.browser_bridge import bridge
    bridge.update_tab_state(tab_status, tab_url)
    task = await bridge.pop_task_for_extension(timeout=0.0)
    if task is None:
        return {"task": None}
    return envelope({"task": task.to_dict()})


@router.post("/task-result")
async def task_result(request: Request):
    """Extension delivers a result for a task it previously claimed.

    The body is envelope-wrapped (`{d: <hex>}`); we unwrap it before
    handing the result back to the awaiting BrowserBridge future.
    """
    from ..services.browser_bridge import bridge

    raw = await request.json()
    try:
        payload = unwrap(raw)
    except Exception as e:
        raise HTTPException(400, f"bad envelope: {e}")

    task_id = payload.get("task_id")
    result = payload.get("result") or {}
    if not task_id:
        raise HTTPException(400, "missing task_id")

    delivered = bridge.deliver_result(task_id, result)
    if not delivered:
        # Either expired or never existed. Log but don't error — the ext
        # may have raced with an internal timeout and that's recoverable.
        log.debug(f"task-result for unknown/expired task_id={task_id}")
        return {"ok": False, "reason": "task expired or unknown"}
    return {"ok": True}


@router.get("/state")
async def bridge_state():
    """Diagnostic — what does the bridge currently know? Used by the
    frontend Settings page to show "Extension connected / disconnected"
    chip.
    """
    from ..services.browser_bridge import bridge
    return bridge.snapshot_state()
