"""Lead/admin monitoring — list members' task_events + usage rollup.

Scope:
  - admin → all members
  - lead  → members of every team they lead (+ themselves)
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import TaskEvent, User
from ..schemas import TaskEventOut, UsageRow
from ..security import require_roles, visible_emails
from ..storage import get_storage

router = APIRouter(prefix="/team", tags=["team"])


@router.get("/tasks", response_model=list[TaskEventOut])
def team_tasks(
    request: Request,
    member: Optional[str] = Query(default=None),
    type: Optional[str] = Query(default=None),
    days: int = Query(default=30, ge=1, le=365),
    limit: int = Query(default=200, ge=1, le=1000),
    user: User = Depends(require_roles("lead", "admin")),
    db: Session = Depends(get_db),
):
    scope = visible_emails(db, user)  # None = all (admin)
    qy = db.query(TaskEvent).filter(
        TaskEvent.created_at >= datetime.utcnow() - timedelta(days=days)
    )
    if scope is not None:
        qy = qy.filter(TaskEvent.email.in_(scope))
    if member:
        qy = qy.filter(TaskEvent.email == member.lower())
    if type:
        qy = qy.filter(TaskEvent.type == type)
    rows = qy.order_by(TaskEvent.id.desc()).limit(limit).all()

    emails = {r.email for r in rows}
    names = (
        {u.email: (u.name or "") for u in db.query(User).filter(User.email.in_(emails)).all()}
        if emails
        else {}
    )

    storage = get_storage()
    base = str(request.base_url)
    out: list[TaskEventOut] = []
    for r in rows:
        thumb_url = storage.url_for(r.thumb_key, base_url=base) if r.thumb_key else None
        out.append(
            TaskEventOut(
                id=r.id, email=r.email, name=names.get(r.email, ""), team_id=r.team_id,
                type=r.type, model=r.model, status=r.status, credit_cost=r.credit_cost or 0,
                prompt=r.prompt or "", thumb_url=thumb_url,
                created_at=r.created_at, finished_at=r.finished_at,
            )
        )
    return out


@router.get("/usage", response_model=list[UsageRow])
def team_usage(
    days: int = Query(default=30, ge=1, le=365),
    user: User = Depends(require_roles("lead", "admin")),
    db: Session = Depends(get_db),
):
    scope = visible_emails(db, user)
    qy = db.query(
        TaskEvent.email,
        func.coalesce(func.sum(TaskEvent.credit_cost), 0),
        func.count(TaskEvent.id),
        func.coalesce(func.sum(case((TaskEvent.status == "error", 1), else_=0)), 0),
    ).filter(TaskEvent.created_at >= datetime.utcnow() - timedelta(days=days))
    if scope is not None:
        qy = qy.filter(TaskEvent.email.in_(scope))
    rows = qy.group_by(TaskEvent.email).all()

    emails = {r[0] for r in rows}
    users = (
        {u.email: u for u in db.query(User).filter(User.email.in_(emails)).all()}
        if emails
        else {}
    )
    out: list[UsageRow] = []
    for email, total, count, errs in rows:
        u = users.get(email)
        out.append(
            UsageRow(
                email=email,
                name=(u.name if u else "") or "",
                team_id=(u.team_id if u else None),
                total_credits=int(total or 0),
                task_count=int(count or 0),
                error_count=int(errs or 0),
            )
        )
    out.sort(key=lambda r: r.total_credits, reverse=True)
    return out
