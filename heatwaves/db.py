"""Database engine and sessions."""

from collections.abc import AsyncIterator, Iterator
from typing import Annotated

import anyio
from fastapi import Depends
from sqlalchemy import Engine, create_engine, make_url
from sqlalchemy.orm import Session, sessionmaker

from heatwaves.config import settings

# The engine's connections: POOL_SIZE kept open, and up to MAX_OVERFLOW more
# opened while those are all in use, each closed once it's back. In-memory
# SQLite keeps one connection per thread instead, with no size to set.
POOL_SIZE = 5
MAX_OVERFLOW = 10

_url = make_url(settings.database_url)
_in_memory = _url.get_backend_name() == "sqlite" and _url.database in (None, "", ":memory:")
engine = create_engine(
    _url, pool_pre_ping=True, **({} if _in_memory else {"pool_size": POOL_SIZE, "max_overflow": MAX_OVERFLOW})
)
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

# The requests holding a session: at most one per connection the engine can
# open. A request holds its connection until its response is sent, and a sync
# route's response is checked in a second trip to the thread pool (40 threads).
# Without this limit, a burst of about 60 requests gave every thread to a request
# waiting for a connection, while those holding one waited for a thread, until
# the pool timed out (30 s) and each request still waiting answered 500. Here a
# request waits for its turn in the event loop, holding no thread.
sessions = anyio.CapacityLimiter(POOL_SIZE + MAX_OVERFLOW)


async def session_slot() -> AsyncIterator[None]:
    """FastAPI dependency: one of `sessions`, awaited without a thread and held until the session closes."""
    async with sessions:
        yield


def get_session(_: Annotated[None, Depends(session_slot)]) -> Iterator[Session]:
    """FastAPI dependency: one session per request, through `reading`."""
    with RequestSession() as session:
        yield session
