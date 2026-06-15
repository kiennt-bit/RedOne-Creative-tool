"""Audit trail — record admin actions + logins for accountability."""
from __future__ import annotations

from sqlalchemy.orm import Session

from .models import AuditLog


def write_audit(db: Session, actor_email: str, action: str, target: str = "", detail: str = "") -> None:
    """Append an audit row. Caller commits. Best-effort (never raise)."""
    try:
        db.add(AuditLog(
            actor_email=(actor_email or "")[:255],
            action=(action or "")[:64],
            target=(target or "")[:255],
            detail=(detail or "")[:500],
        ))
    except Exception:
        pass
