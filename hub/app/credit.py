"""Internal credit ledger + quota-period bookkeeping.

Credit model (charge-at-reserve, reconcile-at-commit):
  - reserve(cost): if affordable, `charge` immediately (used += cost) so two
    concurrent gens can't both slip under the same limit. Returns a
    task_event id used as the reservation handle.
  - commit(actual): if actual != reserved cost, adjust the difference.
  - error/cancel: `refund` the full reserved cost.

All changes append a row to `credit_ledger` for audit.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from .config import settings
from .models import CreditLedger, Quota


def _next_reset(period: str, frm: datetime) -> Optional[datetime]:
    p = (period or "").lower()
    if p == "daily":
        return frm + timedelta(days=1)
    if p == "weekly":
        return frm + timedelta(weeks=1)
    if p == "monthly":
        return frm + timedelta(days=30)  # ~1 month; fine for internal quota
    return None  # "none" → never auto-resets


def get_or_create_quota(db: Session, email: str) -> Quota:
    email = email.lower()
    q = db.get(Quota, email)
    if q is None:
        limit = None if settings.DEFAULT_QUOTA_LIMIT < 0 else settings.DEFAULT_QUOTA_LIMIT
        period = settings.DEFAULT_QUOTA_PERIOD
        now = datetime.utcnow()
        q = Quota(
            email=email,
            period=period,
            limit_credits=limit,
            used_credits=0,
            reset_at=_next_reset(period, now),
        )
        db.add(q)
        db.flush()
    return q


def ensure_period(db: Session, q: Quota) -> None:
    """Roll the usage window over if its reset time has passed."""
    if q.reset_at and datetime.utcnow() >= q.reset_at:
        q.used_credits = 0
        q.reset_at = _next_reset(q.period, datetime.utcnow())
        db.add(CreditLedger(email=q.email, delta=0, reason="period reset"))
        db.add(q)
        db.flush()


def remaining(q: Quota) -> Optional[int]:
    """Credits left this period, or None if unlimited."""
    if q.limit_credits is None:
        return None
    return max(0, q.limit_credits - q.used_credits)


def can_afford(q: Quota, cost: int) -> bool:
    if q.limit_credits is None:
        return True
    return (q.used_credits + max(0, cost)) <= q.limit_credits


def charge(db: Session, q: Quota, cost: int, reason: str, task_event_id: Optional[int] = None) -> None:
    cost = max(0, cost)
    q.used_credits += cost
    db.add(CreditLedger(email=q.email, delta=-cost, reason=reason, task_event_id=task_event_id))
    db.add(q)


def refund(db: Session, q: Quota, amount: int, reason: str, task_event_id: Optional[int] = None) -> None:
    amount = max(0, amount)
    q.used_credits = max(0, q.used_credits - amount)
    db.add(CreditLedger(email=q.email, delta=amount, reason=reason, task_event_id=task_event_id))
    db.add(q)


def reset_usage(db: Session, q: Quota, reason: str = "reset") -> None:
    """Zero the usage counter and start a fresh period (admin action)."""
    q.used_credits = 0
    q.reset_at = _next_reset(q.period, datetime.utcnow())
    db.add(CreditLedger(email=q.email, delta=0, reason=reason))
    db.add(q)
