"""In-process smoke test for the RedOne Hub.

Run from anywhere:  python hub/scripts/smoke_test.py
(or, inside hub/:    python scripts/smoke_test.py)

Uses FastAPI's TestClient + a throwaway sqlite DB. Google is bypassed by
minting Hub tokens directly (issue_hub_token) for seeded users, so no real
id_token is needed. Exercises the whole credit + monitoring loop.
"""
import io
import os
import sys
from pathlib import Path

HUB_ROOT = Path(__file__).resolve().parent.parent
os.chdir(HUB_ROOT)                 # relative sqlite/media land in hub/ (gitignored)
sys.path.insert(0, str(HUB_ROOT))  # so `import app` works

# Config via env BEFORE importing the app.
os.environ.setdefault("DATABASE_URL", "sqlite:///./hub_smoke.db")
os.environ.setdefault("OAUTH_CLIENT_ID", "dummy.apps.googleusercontent.com")
os.environ.setdefault("ALLOWED_DOMAIN", "redone.vn")
os.environ.setdefault("BOOTSTRAP_ADMIN_EMAIL", "kiennt@redone.vn")
os.environ.setdefault("HUB_JWT_SECRET", "smoke-secret")
os.environ.setdefault("STORAGE_BACKEND", "local")
os.environ.setdefault("MEDIA_DIR", "./media")

from fastapi.testclient import TestClient  # noqa: E402

import app.models  # noqa: E402,F401  (register models on Base)
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Team, User  # noqa: E402
from app.security import issue_hub_token  # noqa: E402

failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(("  OK  | " if cond else " FAIL | ") + msg)
    if not cond:
        failures.append(msg)


def auth(email: str) -> dict:
    tok, _ = issue_hub_token(email)
    return {"Authorization": f"Bearer {tok}"}


def jpeg_bytes() -> bytes:
    from PIL import Image

    im = Image.new("RGB", (12, 12), (220, 30, 30))
    buf = io.BytesIO()
    im.save(buf, format="JPEG")
    return buf.getvalue()


def main() -> None:
    # Fresh schema every run.
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)

    s = SessionLocal()
    t = Team(name="Team A", lead_email="bob@redone.vn")
    s.add(t)
    s.flush()
    tid = t.id
    s.add(User(email="kiennt@redone.vn", name="Kien", role="admin"))
    s.add(User(email="bob@redone.vn", name="Bob", role="lead", team_id=tid))
    s.add(User(email="alice@redone.vn", name="Alice", role="member", team_id=tid))
    s.commit()
    s.close()

    with TestClient(app) as c:
        r = c.get("/health")
        check(r.status_code == 200 and r.json().get("ok") is True, "/health ok")

        r = c.get("/me", headers=auth("kiennt@redone.vn"))
        check(r.status_code == 200 and r.json()["role"] == "admin", "admin /me role=admin")

        r = c.post("/admin/quota", headers=auth("kiennt@redone.vn"),
                   json={"email": "alice@redone.vn", "flow_limit": 3, "shakker_limit": 2, "period": "monthly", "reset": True})
        check(r.status_code == 200 and r.json()["flow"]["limit"] == 3 and r.json()["shakker"]["limit"] == 2,
              "admin set alice flow=3 shakker=2")

        r = c.get("/me", headers=auth("alice@redone.vn"))
        qj = r.json().get("quota", {})
        check(r.status_code == 200 and qj["flow"]["remaining"] == 3 and qj["shakker"]["remaining"] == 2,
              "alice flow rem=3, shakker rem=2")

        rids, rems = [], []
        for i in range(3):
            r = c.post("/events/reserve", headers=auth("alice@redone.vn"),
                       json={"type": "image", "model": "nano", "credit_cost": 1, "prompt": f"p{i}"})
            j = r.json()
            rids.append(j.get("reservation_id"))
            rems.append(j.get("remaining"))
            check(r.status_code == 200 and j.get("ok") is True, f"reserve #{i + 1} ok")
        check(rems == [2, 1, 0], f"remaining sequence {rems} == [2,1,0]")

        r = c.post("/events/reserve", headers=auth("alice@redone.vn"),
                   json={"type": "image", "credit_cost": 1})
        check(r.status_code == 200 and r.json().get("ok") is False, "4th reserve blocked (out of credit)")

        r = c.post("/events/commit", headers=auth("alice@redone.vn"),
                   data={"reservation_id": str(rids[0]), "status": "done", "type": "image",
                         "model": "nano", "credit_cost": "1", "prompt": "p0"},
                   files={"thumb": ("t.jpg", jpeg_bytes(), "image/jpeg")})
        j = r.json()
        check(r.status_code == 200 and j.get("ok") and j.get("thumb_url"), "commit #1 done + thumb_url")
        thumb_url = j.get("thumb_url") or ""

        r = c.post("/events/commit", headers=auth("alice@redone.vn"),
                   data={"reservation_id": str(rids[1]), "status": "error", "type": "image", "credit_cost": "1"})
        check(r.status_code == 200 and r.json().get("remaining") == 1, "commit #2 error refunded (flow remaining=1)")

        # Shakker pool is INDEPENDENT of flow.
        srem = []
        for i in range(2):
            r = c.post("/events/reserve", headers=auth("alice@redone.vn"), json={"type": "shakker", "credit_cost": 1})
            srem.append(r.json().get("remaining"))
            check(r.status_code == 200 and r.json()["ok"], f"shakker reserve #{i + 1} ok")
        check(srem == [1, 0], f"shakker remaining {srem} == [1,0]")
        r = c.post("/events/reserve", headers=auth("alice@redone.vn"), json={"type": "shakker", "credit_cost": 1})
        check(r.status_code == 200 and r.json()["ok"] is False and r.json().get("pool") == "shakker",
              "shakker 3rd blocked (independent of flow)")

        # Default user (no quota set) = 0 = blocked.
        r = c.post("/events/reserve", headers=auth("bob@redone.vn"), json={"type": "image", "credit_cost": 1})
        check(r.status_code == 200 and r.json()["ok"] is False, "default quota 0 -> blocked")

        if thumb_url:
            path = thumb_url.split("testserver", 1)[-1] if "testserver" in thumb_url else thumb_url
            r = c.get(path)
            check(r.status_code == 200 and r.headers.get("content-type", "").startswith("image/"),
                  "signed media URL serves image")

        r = c.get("/team/tasks", headers=auth("bob@redone.vn"))
        check(r.status_code == 200 and any(e["email"] == "alice@redone.vn" for e in r.json()),
              "lead /team/tasks sees alice")

        r = c.get("/team/usage", headers=auth("bob@redone.vn"))
        au = next((u for u in r.json() if u["email"] == "alice@redone.vn"), {})
        check(r.status_code == 200 and au.get("flow_credits", 0) > 0 and au.get("shakker_credits", 0) > 0,
              "lead /team/usage has alice (flow+shakker split)")

        r = c.get("/team/tasks", headers=auth("alice@redone.vn"))
        check(r.status_code == 403, "member blocked from /team/tasks (403)")

        r = c.post("/admin/users", headers=auth("kiennt@redone.vn"),
                   json={"email": "carol@redone.vn", "role": "member", "team_id": tid})
        check(r.status_code == 200 and r.json()["email"] == "carol@redone.vn", "admin create user carol")

        # grant adjusts the LIMIT (relative top-up), visible in the list
        r = c.post("/admin/grant", headers=auth("kiennt@redone.vn"),
                   json={"email": "carol@redone.vn", "pool": "flow", "delta": 50, "reason": "test"})
        check(r.status_code == 200 and r.json().get("limit") == 50, "grant flow +50 -> limit 50")
        r = c.get("/admin/users", headers=auth("kiennt@redone.vn"))
        carol = next((u for u in r.json() if u["email"] == "carol@redone.vn"), {})
        check(carol.get("flow_limit") == 50, "user list reflects new flow limit (50)")

        r = c.get("/admin/audit", headers=auth("kiennt@redone.vn"))
        acts = [a.get("action") for a in r.json()] if r.status_code == 200 else []
        check(r.status_code == 200 and "credit.grant" in acts and "quota.set" in acts,
              "audit log records admin actions")

        r = c.post("/admin/users", headers=auth("alice@redone.vn"), json={"email": "x@redone.vn"})
        check(r.status_code == 403, "member blocked from /admin (403)")

    print()
    if failures:
        print(f"SMOKE_FAIL: {len(failures)} check(s) failed")
        sys.exit(1)
    print("SMOKE_OK: all checks passed")


if __name__ == "__main__":
    main()
