"""Database engine and sessions."""

from collections.abc import Iterator

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from heatwaves.config import settings

engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(engine, expire_on_commit=False)


def reading(engine: Engine) -> Engine:
    """`engine` as the API reads through it: on Postgres, each transaction sees one snapshot, and can't write.

    Postgres's default, READ COMMITTED, gives each statement its own, so one
    request's queries could see different sync commits. Each connection goes
    back to the pool as it came. Other databases are left as they are.
    """
    if engine.dialect.name != "postgresql":
        return engine
    return engine.execution_options(isolation_level="REPEATABLE READ", postgresql_readonly=True)


RequestSession = sessionmaker(reading(engine), expire_on_commit=False)


def get_session() -> Iterator[Session]:
    """FastAPI dependency: one session per request, through `reading`."""
    with RequestSession() as session:
        yield session
