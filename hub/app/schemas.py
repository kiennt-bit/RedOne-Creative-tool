"""Pydantic request/response models for the Hub API."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel


# ── Auth ───────────────────────────────────────────────────────────────
class VerifyRequest(BaseModel):
    id_token: str


class VerifyResponse(BaseModel):
    token: str
    email: str
    name: str = ""
    role: str
    team_id: Optional[int] = None
    expires_at: datetime


# ── Me / quota ─────────────────────────────────────────────────────────
class QuotaSummary(BaseModel):
    period: str
    limit_credits: Optional[int] = None  # None = unlimited
    used_credits: int = 0
    remaining: Optional[int] = None      # None = unlimited
    reset_at: Optional[datetime] = None


class MeResponse(BaseModel):
    email: str
    name: str = ""
    role: str
    team_id: Optional[int] = None
    quota: QuotaSummary


# ── Events ─────────────────────────────────────────────────────────────
class ReserveRequest(BaseModel):
    type: str = ""
    model: str = ""
    credit_cost: int = 1
    prompt: str = ""


class ReserveResponse(BaseModel):
    ok: bool
    reservation_id: Optional[int] = None
    remaining: Optional[int] = None
    message: str = ""


class CommitResponse(BaseModel):
    ok: bool
    task_event_id: Optional[int] = None
    thumb_url: Optional[str] = None
    remaining: Optional[int] = None
    message: str = ""


# ── Team dashboard ─────────────────────────────────────────────────────
class TaskEventOut(BaseModel):
    id: int
    email: str
    name: str = ""
    team_id: Optional[int] = None
    type: str = ""
    model: str = ""
    status: str = ""
    credit_cost: int = 0
    prompt: str = ""
    thumb_url: Optional[str] = None
    created_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None


class UsageRow(BaseModel):
    email: str
    name: str = ""
    team_id: Optional[int] = None
    total_credits: int = 0
    task_count: int = 0
    error_count: int = 0


# ── Admin ──────────────────────────────────────────────────────────────
class UserIn(BaseModel):
    email: str
    name: Optional[str] = None
    role: Optional[str] = None      # admin|lead|member
    team_id: Optional[int] = None
    active: Optional[bool] = None


class UserOut(BaseModel):
    email: str
    name: str = ""
    role: str
    team_id: Optional[int] = None
    active: bool = True
    created_at: Optional[datetime] = None


class TeamIn(BaseModel):
    id: Optional[int] = None        # present → update; absent → create
    name: str
    lead_email: Optional[str] = None


class TeamOut(BaseModel):
    id: int
    name: str
    lead_email: Optional[str] = None
    member_count: int = 0


class QuotaIn(BaseModel):
    email: str
    period: Optional[str] = None            # daily|weekly|monthly|none
    limit_credits: Optional[int] = None     # <0 → unlimited; >=0 → cap; omitted → unchanged
    reset: bool = False                     # reset used_credits to 0 now


class GrantIn(BaseModel):
    email: str
    delta: int                              # +grant / -deduct
    reason: str = "manual adjustment"
