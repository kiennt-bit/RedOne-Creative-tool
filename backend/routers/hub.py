"""Local proxy to the RedOne Hub (multi-user management).

The tool frontend (same-origin) calls these `/api/hub/*` endpoints; the local
backend forwards them to the Hub using the stored Hub token. All endpoints sit
behind the existing OAuth login gate automatically.

If the Hub is disabled or unreachable, `/status` reports it and the proxy
endpoints return 503 — the frontend then hides the Team/Quản trị tabs, so a
standalone (no-Hub) build behaves exactly as before.
"""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException

from ..services import hub_client

router = APIRouter(prefix="/api/hub", tags=["hub"])


@router.get("/status")
async def status():
    """Report whether the Hub is enabled/linked + this user's role/quota."""
    if not hub_client.is_enabled():
        return {"enabled": False, "linked": False, "reachable": False}
    sess = hub_client.load_session() or {}
    me = await hub_client.get_me()
    if not me:
        return {
            "enabled": True,
            "linked": bool(sess),
            "reachable": False,
            "email": sess.get("email"),
            "role": sess.get("role"),
            "team_id": sess.get("team_id"),
        }
    return {"enabled": True, "linked": True, "reachable": True, **me}


async def _proxy(method: str, path: str, params=None, json=None):
    st, data = await hub_client.api_request(method, path, params=params, json=json)
    if st == 0:
        raise HTTPException(status_code=503, detail="Hub không kết nối được")
    if st >= 400:
        detail = data.get("detail") if isinstance(data, dict) else None
        raise HTTPException(status_code=st, detail=detail or f"Hub trả lỗi {st}")
    return data


# ── Team monitoring (lead/admin — Hub enforces) ───────────────────────
@router.get("/team/tasks")
async def team_tasks(member: str = "", type: str = "", days: int = 30, limit: int = 200):
    params: dict = {"days": days, "limit": limit}
    if member:
        params["member"] = member
    if type:
        params["type"] = type
    return await _proxy("GET", "/team/tasks", params=params)


@router.get("/team/usage")
async def team_usage(days: int = 30):
    return await _proxy("GET", "/team/usage", params={"days": days})


# ── Admin CRUD (admin — Hub enforces) ─────────────────────────────────
@router.get("/admin/users")
async def admin_users():
    return await _proxy("GET", "/admin/users")


@router.post("/admin/users")
async def admin_user_upsert(body: dict = Body(...)):
    return await _proxy("POST", "/admin/users", json=body)


@router.delete("/admin/users/{email}")
async def admin_user_delete(email: str):
    return await _proxy("DELETE", f"/admin/users/{email}")


@router.get("/admin/teams")
async def admin_teams():
    return await _proxy("GET", "/admin/teams")


@router.post("/admin/teams")
async def admin_team_upsert(body: dict = Body(...)):
    return await _proxy("POST", "/admin/teams", json=body)


@router.delete("/admin/teams/{team_id}")
async def admin_team_delete(team_id: int):
    return await _proxy("DELETE", f"/admin/teams/{team_id}")


@router.post("/admin/quota")
async def admin_quota(body: dict = Body(...)):
    return await _proxy("POST", "/admin/quota", json=body)


@router.post("/admin/grant")
async def admin_grant(body: dict = Body(...)):
    return await _proxy("POST", "/admin/grant", json=body)
