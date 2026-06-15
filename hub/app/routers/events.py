"""Gen lifecycle: reserve credit before a gen, commit (+ thumbnail) after.

Flow on the member's machine:
  reserve(cost) ──► gen locally ──► commit(status, actual_cost, thumbnail)
                └─ blocked here if quota exhausted

Credit is charged at reserve (so concurrent gens can't both slip under the
limit) and reconciled at commit. Errors/cancels refund the reservation.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from sqlalchemy.orm import Session

from .. import credit
from ..db import get_db
from ..models import TaskEvent, User
from ..schemas import CommitResponse, ReserveRequest, ReserveResponse
from ..security import get_current_user
from ..storage import get_storage

router = APIRouter(prefix="/events", tags=["events"])

_PROMPT_MAX = 4000


@router.post("/reserve", response_model=ReserveResponse)
def reserve(
    req: ReserveRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    q = credit.get_or_create_quota(db, user.email)
    credit.ensure_period(db, q)
    cost = max(0, int(req.credit_cost or 0))
    cat = credit.category_for(req.type)

    if not credit.can_afford(q, cat, cost):
        rem = credit.remaining(q, cat)
        db.commit()  # persist any period rollover
        label = "Flow" if cat == "flow" else "Shakker"
        return ReserveResponse(
            ok=False, remaining=rem, pool=cat,
            message=f"Hết credit {label} (còn {rem}). Liên hệ lead để được cấp thêm.",
        )

    ev = TaskEvent(
        email=user.email,
        team_id=user.team_id,
        type=req.type,
        model=req.model,
        status="reserved",
        credit_cost=cost,
        prompt=(req.prompt or "")[:_PROMPT_MAX],
    )
    db.add(ev)
    db.flush()  # assign ev.id
    credit.charge(db, q, cat, cost, reason=f"reserve:{req.type or 'gen'}", task_event_id=ev.id)
    rem = credit.remaining(q, cat)
    rid = ev.id
    db.commit()
    return ReserveResponse(ok=True, reservation_id=rid, remaining=rem, pool=cat)


@router.post("/commit", response_model=CommitResponse)
async def commit(
    request: Request,
    reservation_id: Optional[int] = Form(default=None),
    status: str = Form(default="done"),       # done | error | canceled
    type: str = Form(default=""),
    model: str = Form(default=""),
    credit_cost: int = Form(default=1),
    prompt: str = Form(default=""),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    thumb: Optional[UploadFile] = File(default=None),
):
    q = credit.get_or_create_quota(db, user.email)
    credit.ensure_period(db, q)
    actual = max(0, int(credit_cost or 0))
    is_done = status == "done"
    cat = credit.category_for(type)

    ev = db.get(TaskEvent, reservation_id) if reservation_id else None
    if ev is not None and ev.email != user.email:
        raise HTTPException(status_code=403, detail="Reservation không thuộc về bạn")

    if ev is None:
        # Post-paid path: no prior reserve (e.g. legacy/standalone call).
        ev = TaskEvent(
            email=user.email, team_id=user.team_id, type=type, model=model,
            status="reserved", credit_cost=0, prompt=(prompt or "")[:_PROMPT_MAX],
        )
        db.add(ev)
        db.flush()
        if is_done:
            credit.charge(db, q, cat, actual, reason=f"commit:{type or 'gen'}", task_event_id=ev.id)
            ev.credit_cost = actual
    else:
        reserved = ev.credit_cost or 0
        if is_done:
            diff = actual - reserved
            if diff > 0:
                credit.charge(db, q, cat, diff, reason=f"commit-adj:{type or 'gen'}", task_event_id=ev.id)
            elif diff < 0:
                credit.refund(db, q, cat, -diff, reason=f"commit-adj:{type or 'gen'}", task_event_id=ev.id)
            ev.credit_cost = actual
        else:
            credit.refund(db, q, cat, reserved, reason=f"{status}:{type or 'gen'}", task_event_id=ev.id)
            ev.credit_cost = 0
        if type:
            ev.type = type
        if model:
            ev.model = model
        if prompt:
            ev.prompt = prompt[:_PROMPT_MAX]

    ev.status = "done" if is_done else status
    ev.finished_at = datetime.utcnow()

    thumb_url: Optional[str] = None
    if thumb is not None and is_done:
        data = await thumb.read()
        if data:
            ctype = (thumb.content_type or "image/jpeg").lower()
            ext = "png" if "png" in ctype else "webp" if "webp" in ctype else "jpg"
            key = f"{user.email}/{ev.id}.{ext}"
            storage = get_storage()
            storage.put(key, data, content_type=ctype)
            ev.thumb_key = key
            thumb_url = storage.url_for(key, base_url=str(request.base_url))

    db.add(ev)
    rem = credit.remaining(q, cat)
    eid = ev.id
    db.commit()
    return CommitResponse(ok=True, task_event_id=eid, thumb_url=thumb_url, remaining=rem, pool=cat)
