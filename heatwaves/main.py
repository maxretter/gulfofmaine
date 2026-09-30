"""The JSON API and a health check. The React frontend in frontend/ is served separately.

uvicorn heatwaves.main:app
"""

import asyncio
import contextlib
import hashlib
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import cast

from fastapi import FastAPI, Request, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import func, select

from heatwaves import api, live
from heatwaves.api import SessionDep
from heatwaves.config import settings
from heatwaves.models import Series


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Relay the sync's messages to the live feed's browsers while the app runs (Postgres only)."""
    url = live.libpq_url(settings.database_url)
    relay = asyncio.create_task(live.relay(url, live.hub)) if url else None
    yield
    if relay is not None:
        relay.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await relay


app = FastAPI(
    title="Gulf of Maine heatwaves",
    summary="Marine heatwaves at University of Maine buoys at 1, 20 and 50 m, beside NOAA's satellite data.",
    version="0.2.0",
    redoc_url=None,
    lifespan=lifespan,
)
app.include_router(api.router)


@app.middleware("http")
async def revalidate_api_responses(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Let caches keep API responses, but only reuse one after checking its ETag with the API.

    The live feed can change any of them at any moment, and a browser
    refetching after a message mustn't be handed a copy from its own cache,
    or a proxy's. An unchanged response costs a 304 with no body.
    """
    response = await call_next(request)
    if not request.url.path.startswith("/api/") or response.status_code != 200:
        return response
    chunks = [chunk async for chunk in cast(StreamingResponse, response).body_iterator]
    body = b"".join(chunk.encode() if isinstance(chunk, str) else bytes(chunk) for chunk in chunks)
    etag = f'W/"{hashlib.sha256(body).hexdigest()[:20]}"'
    headers = {"ETag": etag, "Cache-Control": "no-cache"}
    cached = {tag.strip().removeprefix("W/") for tag in request.headers.get("if-none-match", "").split(",")}
    if etag.removeprefix("W/") in cached:
        return Response(status_code=304, headers=headers)
    return Response(body, headers={**response.headers, **headers})


# Added last, so it's outermost and compresses what the rest return. The ETag
# above is of the uncompressed JSON, since gzip's output varies with its timestamp.
# A buoy's full daily record is ~1 MB of JSON; it compresses about tenfold.
app.add_middleware(GZipMiddleware, minimum_size=1000)


@app.get("/healthz", include_in_schema=False)
def healthz(session: SessionDep) -> JSONResponse:
    """503 until the sync job has run, and again if it stops."""
    last_sync = session.scalar(select(func.min(Series.synced_at)))
    healthy = last_sync is not None and api.now() - last_sync < settings.sync_stale_after
    return JSONResponse(
        {"status": "ok" if healthy else "stale", "oldest_sync": last_sync.isoformat() if last_sync else None},
        status_code=200 if healthy else 503,
    )
