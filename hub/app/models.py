"""Hub data model.

Tables
------
users          — identity + role (admin/lead/member) + team membership
teams          — a team and its lead
quotas         — per-user internal credit limit + usage in the current period
credit_ledger  — append-only audit of every credit change (spend/grant/refund)
task_events    — one row per gen attempt a member runs (lead/admin monitoring)

The gen itself still happens locally on each member's machine. These tables
only hold the *management* layer: who, how much, and a thumbnail to preview.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)

from .db import Base


def _utcnow() -> datetime:
    return datetime.utcnow()


class User(Base):
    __tablename__ = "users"

    email = Column(String(255), primary_key=True)
    name = Column(String(255), default="")
    role = Column(String(32), default="member", nullable=False)  # admin | lead | member
    team_id = Column(Integer, ForeignKey("teams.id"), nullable=True)
    active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=_utcnow)


class Team(Base):
    __tablename__ = "teams"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    lead_email = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=_utcnow)


class Quota(Base):
    __tablename__ = "quotas"

    email = Column(String(255), primary_key=True)
    period = Column(String(16), default="monthly", nullable=False)  # daily|weekly|monthly|none
    # Two separate pools. limit: NULL = unlimited, 0 = blocked (DEFAULT), N = cap.
    flow_limit = Column(Integer, nullable=True, default=0)      # Google Flow / Vertex gens
    flow_used = Column(Integer, default=0, nullable=False)
    shakker_limit = Column(Integer, nullable=True, default=0)   # Shakker.ai gens
    shakker_used = Column(Integer, default=0, nullable=False)
    reset_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


class CreditLedger(Base):
    __tablename__ = "credit_ledger"

    id = Column(Integer, primary_key=True, autoincrement=True)
    email = Column(String(255), index=True, nullable=False)
    delta = Column(Integer, nullable=False)  # negative = spend, positive = grant/refund
    reason = Column(String(128), default="")
    task_event_id = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=_utcnow)


class TaskEvent(Base):
    __tablename__ = "task_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    email = Column(String(255), index=True, nullable=False)
    team_id = Column(Integer, nullable=True)
    type = Column(String(32), default="")          # image|video|storyboard|shakker|upscale|...
    model = Column(String(64), default="")
    status = Column(String(16), default="reserved")  # reserved|done|error|canceled
    credit_cost = Column(Integer, default=0)
    prompt = Column(Text, default="")
    thumb_key = Column(String(512), nullable=True)   # storage key; URL is signed on read
    created_at = Column(DateTime, default=_utcnow, index=True)
    finished_at = Column(DateTime, nullable=True)


# Composite index for the common "this member's recent tasks" query.
Index("ix_task_events_email_created", TaskEvent.email, TaskEvent.created_at)
