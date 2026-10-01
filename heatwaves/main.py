"""The JSON API and a health check. The React frontend in frontend/ is served separately.

uvicorn heatwaves.main:app
"""

import asyncio
import base64
import contextlib
import hashlib
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import cast

from fastapi import FastAPI, Request, Response
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from sqlalchemy import func, select
from starlette.middleware.gzip import DEFAULT_EXCLUDED_CONTENT_TYPES, GZipMiddleware

from heatwaves import __version__, api, live, state
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
    summary=(
        "Marine heatwaves at fixed depths from 1 to 250 m on University of Maine buoys in the Gulf of Maine, "
        "beside NOAA's satellite data."
    ),
    version=__version__,
    docs_url=None,  # served below
    redoc_url=None,
    # Starlette would redirect /api/buoys/ to /api/buoys, at the request's Host and the
    # scheme Caddy saw: whatever Host a client sent, and http behind a TLS proxy.
    redirect_slashes=False,
    lifespan=lifespan,
)
app.include_router(api.router)

# Swagger UI at one version, where FastAPI's default takes the newest 5.x on the CDN.
SWAGGER_UI = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.0/"


@app.get("/docs", include_in_schema=False)
def docs() -> HTMLResponse:
    """Swagger UI, with a content security policy that allows its files and its one inline script.

    Caddy gives every other response the app's policy, which would block both.
    """
    page = get_swagger_ui_html(
        openapi_url=cast(str, app.openapi_url),
        title=f"{app.title} - Swagger UI",
        swagger_js_url=f"{SWAGGER_UI}swagger-ui-bundle.js",
        swagger_css_url=f"{SWAGGER_UI}swagger-ui.css",
        swagger_favicon_url="/favicon.svg",  # the app's
    )
    [script] = re.findall(r"<script>(.*?)</script>", bytes(page.body).decode(), re.DOTALL)
    digest = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
    page.headers["Content-Security-Policy"] = (
        f"default-src 'self'; script-src {SWAGGER_UI} 'sha256-{digest}'; style-src {SWAGGER_UI}; "
        "img-src 'self' data:; frame-ancestors 'none'"
    )
    return page


@app.middleware("http")
async def revalidate_api_responses(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Let caches keep API responses, but only reuse one after checking its ETag with the API.

    The live feed can change any of them at any moment, and a browser
    refetching after a message mustn't be handed a copy from its own cache,
    or a proxy's. An unchanged response costs a 304 with no body. The
    downloads under /api/data/ are streamed from disk as they are, with the
    file's own ETag (see api._download), rather than read into memory here.
    """
    response = await call_next(request)
    path = request.url.path
    if not path.startswith("/api/") or path.startswith("/api/data/") or response.status_code != 200:
        return response
    chunks = [chunk async for chunk in cast(StreamingResponse, response).body_iterator]
    body = b"".join(chunk.encode() if isinstance(chunk, str) else bytes(chunk) for chunk in chunks)
    etag = f'W/"{hashlib.sha256(body).hexdigest()[:20]}"'
    headers = {"ETag": etag, "Cache-Control": "no-cache"}
    if etag.removeprefix("W/") in api.if_none_match(request):
        return Response(status_code=304, headers=headers)
    # Replaces any ETag or Cache-Control the route set, whatever its case, rather than adding a second.
    response.headers.update(headers)
    return Response(body, headers=response.headers)


# Added last, so it's outermost and compresses what the rest return. The ETag
# above is of the uncompressed JSON, since gzip's output varies with its timestamp.
# A buoy's full daily record is about 860 KB of JSON, which level 5 gzips about
# 5.8-fold. Before /daily rounded to 0.001 it was 1.3 MB, and level 5 took 36 ms
# where the default, 9, took 88 ms to make it 2% smaller. The downloads go as
# they are, so their Content-Length, ETag and byte ranges are of the file's bytes.
app.add_middleware(
    GZipMiddleware,
    minimum_size=1000,
    compresslevel=5,
    exclude_content_types=(*DEFAULT_EXCLUDED_CONTENT_TYPES, *api.MEDIA_TYPES.values()),
)


@app.get("/healthz", include_in_schema=False)
def healthz(session: SessionDep) -> JSONResponse:
    """503 until the sync job has synced a buoy still reporting, and again once none has lately.

    Every round checks all the buoy depths still reporting, so if none has
    synced within sync_stale_after, the job, or NERACOOS, has stopped. Anything
    else behind (one buoy's failing dataset, a retired buoy, the satellite from
    CoastWatch) doesn't fail the check, but is listed, as is any series never synced.
    """
    now = api.now()
    # Temperature at the buoy depths sync_all checks every round: those whose newest day isn't offline.
    reporting = api.AT_BUOY & (Series.latest_date >= now.date() - state.OFFLINE_AFTER)
    last_sync = session.scalar(select(func.max(Series.synced_at)).where(reporting))
    healthy = last_sync is not None and now - last_sync < settings.sync_stale_after
    series = session.scalars(
        select(Series).order_by(Series.buoy_id, Series.source, Series.depth, Series.variable)
    ).all()
    synced = {each.label: each.synced_at for each in series if each.synced_at is not None}
    oldest_sync = min(synced.values(), default=None)
    return JSONResponse(
        {
            "status": "ok" if healthy else "stale",
            # The newest sync of a buoy still reporting, which the status is judged on.
            "last_sync": last_sync.isoformat() if last_sync else None,
            "oldest_sync": oldest_sync.isoformat() if oldest_sync else None,  # of any series
            "stale": [label for label, at in synced.items() if now - at >= settings.sync_stale_after],
            "never_synced": [each.label for each in series if each.synced_at is None],
        },
        status_code=200 if healthy else 503,
    )
