"""GET /me — current user's identity, role, team, and live quota."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..credit import ensure_period, get_or_create_quota, summary as quota_summary
from ..db import get_db
from ..models import User
from ..schemas import MeResponse, QuotaSummary
from ..security import get_current_user

router = APIRouter(tags=["me"])


@router.get("/me", response_model=MeResponse)
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    q = get_or_create_quota(db, user.email)
    ensure_period(db, q)
    out = MeResponse(
        email=user.email,
        name=user.name or "",
        role=user.role,
        team_id=user.team_id,
        quota=QuotaSummary(**quota_summary(q)),
    )
    db.commit()
    return out
