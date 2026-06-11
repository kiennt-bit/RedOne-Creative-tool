"""RedOne Hub — FastAPI entrypoint.

Run (dev):   uvicorn app.main:app --reload --port 8800   (CWD = hub/)
Run (prod):  uvicorn app.main:app --host 0.0.0.0 --port 8800   behind HTTPS

All config comes from environment / .env — see config.py and ../README.md.
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .config import settings
from .db import init_db
from .routers import admin, auth, events, me, media, team

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("hub")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    if settings.jwt_secret_is_default:
        log.warning(
            "HUB_JWT_SECRET chưa đặt — đang dùng secret DEV không an toàn. "
            "Đặt HUB_JWT_SECRET (chuỗi ngẫu nhiên dài) trong môi trường production."
        )
    if not settings.OAUTH_CLIENT_IDS:
        log.warning(
            "OAUTH_CLIENT_ID chưa đặt — /auth/verify sẽ TỪ CHỐI mọi token. "
            "Đặt = đúng Client ID của tool desktop."
        )
    log.info("Storage backend: %s | DB: %s", settings.STORAGE_BACKEND, settings.DATABASE_URL.split("://", 1)[0])
    if settings.BOOTSTRAP_ADMIN_EMAILS:
        log.info("Bootstrap admin(s): %s", ", ".join(settings.BOOTSTRAP_ADMIN_EMAILS))
    _ret_task = None
    if settings.MEDIA_RETENTION_DAYS > 0:
        _ret_task = asyncio.create_task(_retention_loop())
        log.info("Media retention: %dd (sweep every %dh)", settings.MEDIA_RETENTION_DAYS, settings.RETENTION_SWEEP_HOURS)
    yield
    if _ret_task:
        _ret_task.cancel()


async def _retention_loop():
    """Periodically delete media for task_events older than the retention window.
    Runs the first sweep at startup, then every RETENTION_SWEEP_HOURS."""
    while True:
        try:
            _run_retention()
        except Exception as e:  # noqa: BLE001
            log.warning("retention sweep error: %s", e)
        try:
            await asyncio.sleep(max(1, settings.RETENTION_SWEEP_HOURS) * 3600)
        except asyncio.CancelledError:
            break


def _run_retention() -> None:
    from datetime import datetime, timedelta

    from .db import SessionLocal
    from .models import TaskEvent
    from .storage import get_storage

    cutoff = datetime.utcnow() - timedelta(days=settings.MEDIA_RETENTION_DAYS)
    storage = get_storage()
    db = SessionLocal()
    try:
        rows = db.query(TaskEvent).filter(
            TaskEvent.thumb_key.isnot(None),
            TaskEvent.created_at < cutoff,
        ).all()
        n = 0
        for ev in rows:
            storage.delete(ev.thumb_key)
            ev.thumb_key = None
            n += 1
        if n:
            db.commit()
            log.info("retention: cleared %d old media", n)
    finally:
        db.close()


app = FastAPI(title="RedOne Hub", version=__version__, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", tags=["health"])
def health():
    return {
        "ok": True,
        "service": "redone-hub",
        "version": __version__,
        "storage": settings.STORAGE_BACKEND,
        "oauth_configured": bool(settings.OAUTH_CLIENT_IDS),
    }


app.include_router(auth.router)
app.include_router(me.router)
app.include_router(events.router)
app.include_router(team.router)
app.include_router(admin.router)
app.include_router(media.router)
