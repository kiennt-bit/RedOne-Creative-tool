"""Admin CRUD — users, teams, quotas, credit grants. All runtime-editable.

Everything here is data in the DB, so the org chart, roles, quotas and team
structure can be changed at any time after deploy via the tool's "Quản trị"
tab (which calls these endpoints). The only deploy-time setting is the
BOOTSTRAP_ADMIN_EMAIL env var, used to seed the very first admin.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import credit
from ..db import get_db
from ..models import Quota, Team, User
from ..schemas import GrantIn, QuotaIn, TeamIn, TeamOut, UserIn, UserOut
from ..security import require_roles

router = APIRouter(prefix="/admin", tags=["admin"])
_ROLES = {"admin", "lead", "member"}
admin_dep = require_roles("admin")


# ── Users ──────────────────────────────────────────────────────────────
@router.get("/users", response_model=list[UserOut])
def list_users(_: User = Depends(admin_dep), db: Session = Depends(get_db)):
    quotas = {q.email: q for q in db.query(Quota).all()}
    out: list[UserOut] = []
    for u in db.query(User).order_by(User.email).all():
        q = quotas.get(u.email)
        out.append(UserOut(
            email=u.email, name=u.name or "", role=u.role,
            team_id=u.team_id, active=u.active, created_at=u.created_at,
            period=(q.period if q else "monthly"),
            flow_limit=(q.flow_limit if q else 0),
            flow_used=(q.flow_used if q else 0),
            shakker_limit=(q.shakker_limit if q else 0),
            shakker_used=(q.shakker_used if q else 0),
        ))
    return out


@router.post("/users", response_model=UserOut)
def upsert_user(body: UserIn, _: User = Depends(admin_dep), db: Session = Depends(get_db)):
    if body.role is not None and body.role not in _ROLES:
        raise HTTPException(status_code=400, detail="role không hợp lệ (admin|lead|member)")
    email = body.email.strip().lower()
    if "@" not in email:
        raise HTTPException(status_code=400, detail="email không hợp lệ")
    u = db.get(User, email)
    if u is None:
        u = User(
            email=email, name=body.name or "", role=body.role or "member",
            team_id=body.team_id, active=True if body.active is None else body.active,
        )
        db.add(u)
    else:
        if body.name is not None:
            u.name = body.name
        if body.role is not None:
            u.role = body.role
        if body.team_id is not None:
            u.team_id = body.team_id or None
        if body.active is not None:
            u.active = body.active
    snap = UserOut(
        email=u.email, name=u.name or "", role=u.role,
        team_id=u.team_id, active=u.active, created_at=u.created_at,
    )
    db.commit()
    return snap


@router.delete("/users/{email}")
def delete_user(email: str, actor: User = Depends(admin_dep), db: Session = Depends(get_db)):
    email = email.strip().lower()
    if email == actor.email:
        raise HTTPException(status_code=400, detail="Không thể tự xoá chính mình")
    u = db.get(User, email)
    if u:
        db.delete(u)
        db.commit()
    return {"ok": True}


# ── Teams ──────────────────────────────────────────────────────────────
@router.get("/teams", response_model=list[TeamOut])
def list_teams(_: User = Depends(admin_dep), db: Session = Depends(get_db)):
    counts = dict(
        db.query(User.team_id, func.count(User.email)).group_by(User.team_id).all()
    )
    return [
        TeamOut(id=t.id, name=t.name, lead_email=t.lead_email, member_count=int(counts.get(t.id, 0) or 0))
        for t in db.query(Team).order_by(Team.id).all()
    ]


@router.post("/teams", response_model=TeamOut)
def upsert_team(body: TeamIn, _: User = Depends(admin_dep), db: Session = Depends(get_db)):
    lead_email = (body.lead_email or "").strip().lower() or None
    if body.id:
        t = db.get(Team, body.id)
        if not t:
            raise HTTPException(status_code=404, detail="Team không tồn tại")
        t.name = body.name
        t.lead_email = lead_email
    else:
        t = Team(name=body.name, lead_email=lead_email)
        db.add(t)
    db.flush()
    # Assigning a lead auto-promotes that user from member→lead (never demotes).
    if lead_email:
        lead = db.get(User, lead_email)
        if lead and lead.role == "member":
            lead.role = "lead"
    tid, name = t.id, t.name
    db.commit()
    return TeamOut(id=tid, name=name, lead_email=lead_email, member_count=0)


@router.delete("/teams/{team_id}")
def delete_team(team_id: int, _: User = Depends(admin_dep), db: Session = Depends(get_db)):
    t = db.get(Team, team_id)
    if t:
        for u in db.query(User).filter(User.team_id == team_id).all():
            u.team_id = None
        db.delete(t)
        db.commit()
    return {"ok": True}


# ── Quota / credit ─────────────────────────────────────────────────────
@router.post("/quota")
def set_quota(body: QuotaIn, _: User = Depends(admin_dep), db: Session = Depends(get_db)):
    q = credit.get_or_create_quota(db, body.email)
    if body.period is not None:
        q.period = body.period.strip().lower()
    # <0 → unlimited (NULL); >=0 → hard cap; omitted → unchanged
    if body.flow_limit is not None:
        q.flow_limit = None if body.flow_limit < 0 else int(body.flow_limit)
    if body.shakker_limit is not None:
        q.shakker_limit = None if body.shakker_limit < 0 else int(body.shakker_limit)
    if body.reset:
        credit.reset_usage(db, q, reason="admin reset")
    db.add(q)
    snap = credit.summary(q)
    snap["email"] = q.email
    db.commit()
    return snap


@router.post("/grant")
def grant(body: GrantIn, _: User = Depends(admin_dep), db: Session = Depends(get_db)):
    """Adjust a user's usage. delta>0 returns credit (lowers used), delta<0
    deducts (raises used). To give *more than the cap*, raise limit via /quota."""
    q = credit.get_or_create_quota(db, body.email)
    cat = "shakker" if (body.pool or "flow").strip().lower() == "shakker" else "flow"
    if body.delta >= 0:
        credit.refund(db, q, cat, body.delta, reason=body.reason)
    else:
        credit.charge(db, q, cat, -body.delta, reason=body.reason)
    snap = {"email": q.email, "pool": cat, "remaining": credit.remaining(q, cat)}
    db.commit()
    return snap
