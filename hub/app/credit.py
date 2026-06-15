"""Internal credit — TWO separate pools per user, per period.

Pools:
  - flow:    Google Flow / Vertex gens (image, video, storyboard, long-video)
  - shakker: Shakker.ai gens
Each pool has its own limit + usage:
  limit = NULL → unlimited · 0 → blocked (DEFAULT) · N → hard cap
Usage resets every period. Charge-at-reserve, reconcile-at-commit, refund on
error/cancel. Every change appends a `credit_ledger` row for audit.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from .models import CreditLedger, Quota

CATEGORIES = ("flow", "shakker")


def category_for(type_: str) -> str:
    """Map a gen `type` to its credit pool. Shakker has its own pool;
    everything else (image/video/storyboard/upscale/...) draws from flow."""
    return "shakker" if (type_ or "").strip().lower() == "shakker" else "flow"


def _next_reset(period: str, frm: datetime) -> Optional[datetime]:
    p = (period or "").lower()
    if p == "daily":
        return frm + timedelta(days=1)
    if p == "weekly":
        return frm + timedelta(weeks=1)
    if p == "monthly":
        return frm + timedelta(days=30)
    return None  # "none" → never auto-resets


def get_or_create_quota(db: Session, email: str) -> Quota:
    email = email.lower()
    q = db.get(Quota, email)
    if q is None:
        now = datetime.utcnow()
        # Default 0 → blocked until an admin grants a limit (per policy).
        q = Quota(
            email=email, period="monthly",
            flow_limit=0, flow_used=0, shakker_limit=0, shakker_used=0,
            reset_at=_next_reset("monthly", now),
        )
        db.add(q)
        db.flush()
    return q


def ensure_period(db: Session, q: Quota) -> None:
    """Roll BOTH pools' usage over if the reset time has passed."""
    if q.reset_at and datetime.utcnow() >= q.reset_at:
        q.flow_used = 0
        q.shakker_used = 0
        q.reset_at = _next_reset(q.period, datetime.utcnow())
        db.add(CreditLedger(email=q.email, delta=0, reason="period reset"))
        db.add(q)
        db.flush()


# ── per-pool accessors ─────────────────────────────────────────────────
def _limit(q: Quota, cat: str) -> Optional[int]:
    return q.flow_limit if cat == "flow" else q.shakker_limit


def _used(q: Quota, cat: str) -> int:
    return (q.flow_used if cat == "flow" else q.shakker_used) or 0


def _set_used(q: Quota, cat: str, value: int) -> None:
    if cat == "flow":
        q.flow_used = value
    else:
        q.shakker_used = value


def remaining(q: Quota, cat: str) -> Optional[int]:
    lim = _limit(q, cat)
    if lim is None:
        return None  # unlimited
    return max(0, lim - _used(q, cat))


def can_afford(q: Quota, cat: str, cost: int) -> bool:
    lim = _limit(q, cat)
    if lim is None:
        return True
    return (_used(q, cat) + max(0, cost)) <= lim


def charge(db: Session, q: Quota, cat: str, cost: int, reason: str, task_event_id: Optional[int] = None) -> None:
    cost = max(0, cost)
    _set_used(q, cat, _used(q, cat) + cost)
    db.add(CreditLedger(email=q.email, delta=-cost, reason=f"{cat}:{reason}", task_event_id=task_event_id))
    db.add(q)


def refund(db: Session, q: Quota, cat: str, amount: int, reason: str, task_event_id: Optional[int] = None) -> None:
    amount = max(0, amount)
    _set_used(q, cat, max(0, _used(q, cat) - amount))
    db.add(CreditLedger(email=q.email, delta=amount, reason=f"{cat}:{reason}", task_event_id=task_event_id))
    db.add(q)


def reset_usage(db: Session, q: Quota, reason: str = "reset") -> None:
    q.flow_used = 0
    q.shakker_used = 0
    q.reset_at = _next_reset(q.period, datetime.utcnow())
    db.add(CreditLedger(email=q.email, delta=0, reason=reason))
    db.add(q)


def summary(q: Quota) -> dict:
    """Both pools, for /me and admin listing."""
    return {
        "period": q.period,
        "flow": {"limit": q.flow_limit, "used": _used(q, "flow"), "remaining": remaining(q, "flow")},
        "shakker": {"limit": q.shakker_limit, "used": _used(q, "shakker"), "remaining": remaining(q, "shakker")},
        "reset_at": q.reset_at,
    }
