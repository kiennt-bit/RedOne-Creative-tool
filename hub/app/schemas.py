"""Pydantic request/response models for the Hub API."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


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


# ── Me / quota (two pools: flow + shakker) ─────────────────────────────
class PoolSummary(BaseModel):
    limit: Optional[int] = None   # None = unlimited, 0 = blocked, N = cap
    used: int = 0
    remaining: Optional[int] = None


class QuotaSummary(BaseModel):
    period: str = "monthly"
    flow: PoolSummary = Field(default_factory=PoolSummary)
    shakker: PoolSummary = Field(default_factory=PoolSummary)
    reset_at: Optional[datetime] = None


class MeResponse(BaseModel):
    email: str
    name: str = ""
    role: str
    team_id: Optional[int] = None
    quota: QuotaSummary = Field(default_factory=QuotaSummary)


# ── Events ─────────────────────────────────────────────────────────────
class ReserveRequest(BaseModel):
    type: str = ""
    model: str = ""
    credit_cost: int = 1
    prompt: str = ""


class ReserveResponse(BaseModel):
    ok: bool
    reservation_id: Optional[int] = None
    remaining: Optional[int] = None   # remaining in the affected pool
    pool: str = ""                    # "flow" | "shakker"
    message: str = ""


class CommitResponse(BaseModel):
    ok: bool
    task_event_id: Optional[int] = None
    thumb_url: Optional[str] = None
    remaining: Optional[int] = None
    pool: str = ""
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
    # Per-pool limits/usage (0 default when no quota row exists).
    period: str = "monthly"
    flow_limit: Optional[int] = 0
    flow_used: int = 0
    shakker_limit: Optional[int] = 0
    shakker_used: int = 0


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
    period: Optional[str] = None             # daily|weekly|monthly|none
    flow_limit: Optional[int] = None         # <0 → unlimited; >=0 → cap; omitted → unchanged
    shakker_limit: Optional[int] = None      # same semantics
    reset: bool = False                      # reset BOTH pools' usage to 0 now


class GrantIn(BaseModel):
    email: str
    pool: str = "flow"                       # flow | shakker
    delta: int                               # +grant / -deduct
    reason: str = "manual adjustment"
