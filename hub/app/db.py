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
    _migrate_sqlite_add_columns()


def _migrate_sqlite_add_columns() -> None:
    """Lightweight additive migration for an EXISTING sqlite DB (trial). On a
    fresh Postgres/MySQL, create_all() already makes the full schema, so this
    is a no-op there. Adds columns introduced after the first release."""
    if not settings.DATABASE_URL.startswith("sqlite"):
        return
    adds = [
        ("quotas", "flow_limit", "INTEGER DEFAULT 0"),
        ("quotas", "flow_used", "INTEGER DEFAULT 0"),
        ("quotas", "shakker_limit", "INTEGER DEFAULT 0"),
        ("quotas", "shakker_used", "INTEGER DEFAULT 0"),
    ]
    try:
        with engine.begin() as conn:
            for table, col, decl in adds:
                cols = [r[1] for r in conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()]
                if col not in cols:
                    conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
    except Exception:
        pass
