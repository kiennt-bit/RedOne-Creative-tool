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
    is a no-op there. Adds columns introduced after the first release, and
    drops dead pre-split columns whose NOT NULL constraint breaks new inserts."""
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
    # Drop dead single-pool columns. The pre-split schema had `limit_credits` +
    # `used_credits` (the latter NOT NULL, no default). The current Quota model
    # no longer sets them, so inserting a NEW quota row (first-time /admin/grant
    # or /admin/quota for a member) failed with
    # "NOT NULL constraint failed: quotas.used_credits" → HTTP 500. They hold no
    # live data (the tool uses flow_*/shakker_* now). Needs SQLite >= 3.35.
    for col in ("used_credits", "limit_credits"):
        try:
            with engine.begin() as conn:
                cols = [r[1] for r in conn.exec_driver_sql("PRAGMA table_info(quotas)").fetchall()]
                if col in cols:
                    conn.exec_driver_sql(f"ALTER TABLE quotas DROP COLUMN {col}")
        except Exception:
            pass
