"""Shakker account management endpoints.

Differs from `accounts.py` (Flow accounts) in two key ways:

1. **No interactive login flow** — the Chrome Extension on shakker.ai is what
   captures `token` / `user_uuid` / etc. and POSTs them to `/sync`. The tool
   never opens a browser itself for shakker. If the token goes stale, we
   show a banner asking the user to open shakker.ai and re-login in their
   real Chrome — the extension picks up the new token automatically.

2. **Identity is `user_uuid`, not email** — gmail users can have multiple
   shakker accounts on the same email theoretically, and the uuid is the
   stable PK that shakker uses internally.
"""
from __future__ import annotations
import logging
from datetime import datetime
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..database import db
from ..ws_hub import hub

log = logging.getLogger("redone.shakker_accounts")
router = APIRouter(prefix="/api/shakker-accounts", tags=["shakker_accounts"])


# ─────────────────────────────────────────────────────────────
# Models
# ─────────────────────────────────────────────────────────────

class SyncAccount(BaseModel):
    """Payload from the Chrome Extension after it reads shakker.ai state.

    All fields except `user_uuid` and `token` are optional — we only need
    those two to make API calls. The rest are nice-to-haves for the UI
    (display email, show credit, etc.) and will be refreshed on the next
    `/check` call anyway.
    """
    user_uuid: str
    token: str
    email: Optional[str] = None
    user_id: Optional[int] = None
    account_id: Optional[int] = None


# ─────────────────────────────────────────────────────────────
# CRUD
# ─────────────────────────────────────────────────────────────

@router.get("")
async def list_accounts():
    """Return all shakker accounts. Strips the `token` column from the
    response — tokens are sensitive and the UI never needs to display them
    (it just shows credit / status). Backend code uses `db.get_shakker_account()`
    directly when it needs the token."""
    accounts = []
    for a in db.get_shakker_accounts():
        a_safe = {k: v for k, v in a.items() if k != "token"}
        a_safe["has_token"] = bool(a.get("token"))
        accounts.append(a_safe)
    return {"accounts": accounts}


@router.post("/sync")
async def sync_account(body: SyncAccount):
    """Called by the Chrome Extension whenever it sees shakker.ai state.

    Upserts by `user_uuid`. Always refreshes the token (it may have rotated).
    Other fields are only written if provided (extension may send a slim
    update like {user_uuid, token} after a credit-only refresh).
    """
    if not body.user_uuid or not body.token:
        raise HTTPException(400, "user_uuid and token required")

    fields = {
        "token": body.token,
        "status": "OK",
        "status_msg": None,
        "last_check_at": datetime.utcnow().isoformat(timespec="seconds"),
    }
    if body.email:
        fields["email"] = body.email.strip().lower()
    if body.user_id is not None:
        fields["user_id"] = body.user_id
    if body.account_id is not None:
        fields["account_id"] = body.account_id

    acc_id = db.upsert_shakker_account(body.user_uuid, **fields)
    log.info(f"shakker /sync upserted account id={acc_id} uuid={body.user_uuid[:8]}…")
    await hub.broadcast("shakker_account_synced", {"id": acc_id, "user_uuid": body.user_uuid})
    return {"ok": True, "id": acc_id}


@router.delete("/{account_id}")
async def delete_account(account_id: int):
    if not db.get_shakker_account(account_id):
        raise HTTPException(404, "Shakker account not found")
    db.delete_shakker_account(account_id)
    await hub.broadcast("shakker_account_deleted", {"id": account_id})
    return {"ok": True}


@router.post("/{account_id}/toggle")
async def toggle_account(account_id: int):
    acc = db.get_shakker_account(account_id)
    if not acc:
        raise HTTPException(404, "Shakker account not found")
    new_state = 0 if acc["enabled"] else 1
    db.update_shakker_account(account_id, enabled=new_state)
    await hub.broadcast(
        "shakker_account_updated",
        {"id": account_id, "enabled": bool(new_state)},
    )
    return {"ok": True, "enabled": bool(new_state)}


# ─────────────────────────────────────────────────────────────
# Credit check
# ─────────────────────────────────────────────────────────────
#
# We call /api/www/member/account with the stored token and:
#   • mirror the {tier, totalPower, usedPower, usablePower, expiry} fields
#     back into the DB so the UI can show them
#   • interpret HTTP 401 / shakker code != 0 as "token expired" and flip
#     status → TOKEN_EXPIRED so the frontend renders a re-login banner
#
# This is a minimal inline implementation. Phase 2 will replace it with a
# full `ShakkerClient` service that also handles list_models / generate /
# poll / upload / etc. For now we just need credit-check working so the
# Settings page can render an account list.


def _build_check_url() -> str:
    return "https://www.shakker.ai/api/www/member/account"


async def _fetch_balance(token: str) -> dict:
    """Call shakker balance API. Returns {ok, alive, balance_dict, error}.

    Uses httpx because the rest of the codebase already depends on it (via
    google-genai / FastAPI deps), no new import.
    """
    import httpx
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                _build_check_url(),
                headers={"token": token, "Accept": "application/json"},
            )
            if resp.status_code == 401 or resp.status_code == 403:
                return {"ok": False, "alive": False, "error": "Token hết hạn"}
            if resp.status_code >= 500:
                return {"ok": False, "alive": True, "error": f"Shakker {resp.status_code}"}
            try:
                body = resp.json()
            except Exception:
                return {"ok": False, "alive": True, "error": "Response không phải JSON"}
            if not isinstance(body, dict):
                return {"ok": False, "alive": True, "error": "Response sai cấu trúc"}
            if body.get("code") != 0:
                # code != 0 typically means auth invalid in shakker convention
                return {"ok": False, "alive": False,
                        "error": body.get("msg") or "Shakker trả lỗi xác thực"}
            return {"ok": True, "alive": True, "data": body.get("data") or {}}
    except httpx.TimeoutException:
        return {"ok": False, "alive": True, "error": "Timeout khi gọi Shakker"}
    except Exception as e:
        return {"ok": False, "alive": True, "error": f"Lỗi mạng: {e}"}


@router.post("/{account_id}/check")
async def check_account(account_id: int):
    acc = db.get_shakker_account(account_id)
    if not acc:
        raise HTTPException(404, "Shakker account not found")
    if not acc.get("token"):
        return {"ok": False, "reason": "no_token",
                "message": "Tài khoản chưa có token — mở shakker.ai trong Chrome để extension đồng bộ"}

    result = await _fetch_balance(acc["token"])
    now = datetime.utcnow().isoformat(timespec="seconds")

    if not result["ok"]:
        update = {
            "status": "TOKEN_EXPIRED" if not result.get("alive") else "ERROR",
            "status_msg": result.get("error") or "Không rõ",
            "last_check_at": now,
        }
        db.update_shakker_account(account_id, **update)
        await hub.broadcast("shakker_account_updated", {"id": account_id, **update})
        return {"ok": False, "alive": result.get("alive"), "message": update["status_msg"]}

    data = result["data"]
    attr = (data.get("attr") or {}) if isinstance(data, dict) else {}
    update = {
        "tier": data.get("accountLevelDesc") or "FREE",
        "total_power": int(attr.get("totalPower") or 0),
        "used_power": int(attr.get("usedPower") or 0),
        "usable_power": int(attr.get("usablePower") or 0),
        "concurrent": int(attr.get("concurrent") or 1),
        "expiry": data.get("endTime"),
        "status": "OK",
        "status_msg": None,
        "last_check_at": now,
    }
    db.update_shakker_account(account_id, **update)
    await hub.broadcast("shakker_account_updated", {"id": account_id, **update})
    return {"ok": True, "alive": True, **update}


@router.post("/check-all")
async def check_all_accounts():
    results = []
    for acc in db.get_shakker_accounts():
        if not acc.get("enabled"):
            continue
        try:
            r = await check_account(acc["id"])
            results.append({"id": acc["id"], **(r if isinstance(r, dict) else {})})
        except Exception as e:
            results.append({"id": acc["id"], "ok": False, "message": str(e)})
    return {"results": results}
