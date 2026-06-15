"""Shared-account credentials per team.

A whole team gens with ONE shared account (the lead's Google Flow + Shakker).
- The team's **lead** or an **admin** sets / views (masked) / clears the
  credentials.
- A **member** of the team fetches them DECRYPTED (`/me/team-credentials`)
  purely so the tool/extension can auto-login. They are never shown in any UI.

Secrets are stored encrypted at rest (see encryption.py). The plaintext is
returned only over HTTPS to a member of the owning team.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..audit import write_audit
from ..db import get_db
from ..encryption import decrypt, encrypt
from ..models import Team, TeamCredentials, User
from ..schemas import TeamCredentialsIn, TeamCredentialsMasked, TeamCredentialsSecret
from ..security import get_current_user

router = APIRouter(tags=["credentials"])


def _leads_team(db: Session, user: User, team_id: int) -> bool:
    team = db.get(Team, team_id)
    return bool(
        team and team.lead_email
        and team.lead_email.strip().lower() == (user.email or "").lower()
    )


def _can_manage(db: Session, user: User, team_id: int) -> bool:
    """Admin → any team; lead → only a team they lead."""
    if user.role == "admin":
        return True
    if user.role == "lead":
        return _leads_team(db, user, team_id)
    return False


def _resolve_team_id(db: Session, user: User, team_id: Optional[int]) -> Optional[int]:
    """Fall back to the lead's own team (or the user's team) when not given."""
    if team_id is not None:
        return team_id
    if user.role == "lead":
        t = db.query(Team).filter(Team.lead_email == user.email).first()
        if t:
            return t.id
    return user.team_id


def _masked(tc: TeamCredentials) -> TeamCredentialsMasked:
    return TeamCredentialsMasked(
        team_id=tc.team_id,
        google_email=tc.google_email or "",
        google_password_set=bool(tc.google_password_enc),
        shakker_token_set=bool(tc.shakker_token_enc),
        updated_by=tc.updated_by or "",
        updated_at=tc.updated_at,
    )


@router.post("/team-credentials", response_model=TeamCredentialsMasked)
def set_team_credentials(
    body: TeamCredentialsIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    team_id = _resolve_team_id(db, user, body.team_id)
    if team_id is None:
        raise HTTPException(400, "Thiếu team_id")
    if not _can_manage(db, user, team_id):
        raise HTTPException(403, "Chỉ lead của nhóm hoặc admin được đặt tài khoản chung")

    tc = db.get(TeamCredentials, team_id)
    if tc is None:
        tc = TeamCredentials(team_id=team_id)
        db.add(tc)
    if body.google_email is not None:
        tc.google_email = body.google_email.strip()
    # Only overwrite a secret when a non-empty new value is supplied; this lets
    # the UI re-save the email without re-typing the password.
    if body.google_password:
        tc.google_password_enc = encrypt(body.google_password)
    if body.shakker_token:
        tc.shakker_token_enc = encrypt(body.shakker_token)
    if body.shakker_webid is not None:
        tc.shakker_webid_enc = encrypt(body.shakker_webid) if body.shakker_webid else None
    tc.updated_by = user.email
    write_audit(db, user.email, "credentials.set", f"team:{team_id}", "shared account updated")
    db.commit()
    db.refresh(tc)
    return _masked(tc)


@router.get("/team-credentials", response_model=TeamCredentialsMasked)
def get_team_credentials(
    team_id: Optional[int] = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    tid = _resolve_team_id(db, user, team_id)
    if tid is None:
        raise HTTPException(400, "Thiếu team_id")
    if not _can_manage(db, user, tid):
        raise HTTPException(403, "Không đủ quyền xem tài khoản chung")
    tc = db.get(TeamCredentials, tid)
    if tc is None:
        return TeamCredentialsMasked(team_id=tid)
    return _masked(tc)


@router.delete("/team-credentials")
def delete_team_credentials(
    team_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not _can_manage(db, user, team_id):
        raise HTTPException(403, "Không đủ quyền")
    tc = db.get(TeamCredentials, team_id)
    if tc is not None:
        db.delete(tc)
        write_audit(db, user.email, "credentials.delete", f"team:{team_id}", "")
        db.commit()
    return {"ok": True}


@router.get("/me/team-credentials", response_model=TeamCredentialsSecret)
def my_team_credentials(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Decrypted shared credentials of the caller's team, for auto-login.
    Empty if the user has no team or it has no credentials set."""
    if not user.team_id:
        return TeamCredentialsSecret()
    tc = db.get(TeamCredentials, user.team_id)
    if tc is None:
        return TeamCredentialsSecret()
    gpw = decrypt(tc.google_password_enc) or ""
    stoken = decrypt(tc.shakker_token_enc) or ""
    return TeamCredentialsSecret(
        google_email=tc.google_email or "",
        google_password=gpw,
        shakker_token=stoken,
        shakker_webid=decrypt(tc.shakker_webid_enc) or "",
        has_google=bool((tc.google_email or "") and gpw),
        has_shakker=bool(stoken),
    )
