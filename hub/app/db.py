"""SQLAlchemy engine + session. DB-agnostic (sqlite/postgres/mysql)."""
from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from .config import settings

_connect_args: dict = {}
if settings.DATABASE_URL.startswith("sqlite"):
    # Needed because FastAPI serves requests across threads.
    _connect_args = {"check_same_thread": False}

engine = create_engine(
    settings.DATABASE_URL,
    connect_args=_connect_args,
    pool_pre_ping=True,
    future=True,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()


def get_db():
    """FastAPI dependency — one session per request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create tables on startup. Greenfield internal service → create_all is
    enough for now. When the schema evolves later, introduce Alembic
    migrations (the models here are Alembic-ready)."""
    from . import models  # noqa: F401  (register models on Base)

    Base.metadata.create_all(bind=engine)
