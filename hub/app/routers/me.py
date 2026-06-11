"""GET /me — current user's identity, role, team, and live quota."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..credit import ensure_period, get_or_create_quota, remaining
from ..db import get_db
from ..models import User
from ..schemas import MeResponse, QuotaSummary
from ..security import get_current_user

router = APIRouter(tags=["me"])


@router.get("/me", response_model=MeResponse)
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    q = get_or_create_quota(db, user.email)
    ensure_period(db, q)
    summary = QuotaSummary(
        period=q.period,
        limit_credits=q.limit_credits,
        used_credits=q.used_credits,
        remaining=remaining(q),
        reset_at=q.reset_at,
    )
    out = MeResponse(
        email=user.email,
        name=user.name or "",
        role=user.role,
        team_id=user.team_id,
        quota=summary,
    )
    db.commit()
    return out
