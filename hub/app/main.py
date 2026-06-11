"""RedOne Hub — FastAPI entrypoint.

Run (dev):   uvicorn app.main:app --reload --port 8800   (CWD = hub/)
Run (prod):  uvicorn app.main:app --host 0.0.0.0 --port 8800   behind HTTPS

All config comes from environment / .env — see config.py and ../README.md.
"""
from __future__ import annotations

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
    yield


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
