"""POST /auth/verify — exchange a Google id_token for a Hub session token.

Called once by the tool right after Google login. The Hub cryptographically
verifies the token (so it doesn't trust the client's claimed email), upserts
the user, then returns a long-lived Hub token used for all later calls.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import User
from ..schemas import VerifyRequest, VerifyResponse
from ..security import AuthError, issue_hub_token, verify_google_id_token

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/verify", response_model=VerifyResponse)
def verify(req: VerifyRequest, db: Session = Depends(get_db)):
    try:
        claims = verify_google_id_token(req.id_token)
    except AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))

    email = claims["email"].lower()
    name = claims.get("name") or ""

    user = db.get(User, email)
    if user is None:
        role = "admin" if email in settings.BOOTSTRAP_ADMIN_EMAILS else "member"
        user = User(email=email, name=name, role=role, active=True)
        db.add(user)
    else:
        if not user.active:
            raise HTTPException(status_code=403, detail="Tài khoản đã bị khoá")
        if name:
            user.name = name
        # Promote to admin if the email was added to the bootstrap list later.
        if email in settings.BOOTSTRAP_ADMIN_EMAILS and user.role != "admin":
            user.role = "admin"

    # Snapshot before commit (avoids post-commit attribute reload surprises).
    final_name, role, team_id = (user.name or name), user.role, user.team_id
    db.commit()

    token, exp = issue_hub_token(email)
    return VerifyResponse(
        token=token,
        email=email,
        name=final_name,
        role=role,
        team_id=team_id,
        expires_at=exp,
    )
