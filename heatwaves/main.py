"""The JSON API and a health check. The React frontend in frontend/ is served separately.

uvicorn heatwaves.main:app
"""

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import func, select

from heatwaves import api
from heatwaves.api import SessionDep
from heatwaves.config import settings
from heatwaves.models import Series

app = FastAPI(
    title="Gulf of Maine heatwaves",
    summary="Marine heatwaves at NERACOOS buoys, at 1, 20 and 50 m, from NERACOOS ERDDAP.",
    version="0.2.0",
    redoc_url=None,
)
app.include_router(api.router)
# A buoy's full daily record is ~1 MB of JSON; it compresses about tenfold.
app.add_middleware(GZipMiddleware, minimum_size=1000)


@app.middleware("http")
async def cache_api_responses(request: Request, call_next):
    response = await call_next(request)
    # The data changes at most hourly.
    if request.url.path.startswith("/api/") and response.status_code == 200:
        response.headers.setdefault("Cache-Control", "public, max-age=300")
    return response


@app.get("/healthz", include_in_schema=False)
def healthz(session: SessionDep) -> JSONResponse:
    """503 until the sync job has run, and again if it stops."""
    last_sync = session.scalar(select(func.min(Series.synced_at)))
    healthy = last_sync is not None and api.now() - last_sync < settings.sync_stale_after
    return JSONResponse(
        {"status": "ok" if healthy else "stale", "oldest_sync": last_sync.isoformat() if last_sync else None},
        status_code=200 if healthy else 503,
    )
