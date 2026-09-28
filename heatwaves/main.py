"""The web application: the JSON API, the HTML pages and a health check.

uvicorn heatwaves.main:app
"""

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select

from heatwaves import api, pages
from heatwaves.api import SessionDep
from heatwaves.config import settings
from heatwaves.models import Series

app = FastAPI(
    title="Gulf of Maine heatwaves",
    summary="Marine heatwaves at NERACOOS buoys, at 1, 20 and 50 m, from NERACOOS ERDDAP.",
    version="0.1.0",
    redoc_url=None,
)
app.include_router(api.router)
app.include_router(pages.router)
app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")


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
