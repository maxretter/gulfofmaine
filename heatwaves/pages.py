"""Server-rendered HTML pages.

Tables and text render on the server, so every number is readable without
JavaScript; the map and charts are drawn on top in the browser from the
JSON API.
"""

import hashlib
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from heatwaves import api
from heatwaves.api import SessionDep
from heatwaves.config import settings
from heatwaves.hobday import CATEGORIES
from heatwaves.models import DailyMean, Event, Series
from heatwaves.stations import BASELINE, DEPTHS

HERE = Path(__file__).parent
router = APIRouter(include_in_schema=False)
templates = Jinja2Templates(directory=HERE / "templates")

# Appended to static URLs so browsers pick up new CSS and JS after a deploy.
ASSET_VERSION = hashlib.sha256(
    b"".join(path.read_bytes() for path in sorted((HERE / "static").glob("*")))
).hexdigest()[:10]

templates.env.globals.update(
    asset_version=ASSET_VERSION,
    baseline=BASELINE,
    categories=CATEGORIES,
    depths=DEPTHS,
    erddap_url=settings.erddap_url,
)


def page_context(session) -> dict:
    return {
        "data_through": session.scalar(select(func.max(Series.latest_date))),
        "synced_at": session.scalar(select(func.max(Series.synced_at))),
    }


@router.get("/", response_class=HTMLResponse)
def overview(request: Request, session: SessionDep, depth: int = DEPTHS[0]):
    if depth not in DEPTHS:
        raise HTTPException(404, f"Depth must be one of {', '.join(map(str, DEPTHS))} m")
    buoys = api.buoy_conditions(session, api.today())
    rows = [(buoy, next(c for c in buoy.series if c.depth == depth)) for buoy in buoys]
    return templates.TemplateResponse(
        request,
        "overview.html",
        {
            **page_context(session),
            "depth": depth,
            "rows": rows,
            "buoys_json": [buoy.model_dump(mode="json") for buoy in buoys],
        },
    )


@router.get("/buoys/{buoy_id}", response_class=HTMLResponse)
def buoy_page(buoy_id: str, request: Request, session: SessionDep):
    buoy = api.get_buoy(buoy_id, session)
    events = session.scalars(
        select(Event)
        .join(Series)
        .options(selectinload(Event.series))
        .where(Series.buoy_id == buoy.id)
        .order_by(Event.start_date.desc())
    ).all()
    first_day = session.scalar(select(func.min(DailyMean.date)).join(Series).where(Series.buoy_id == buoy.id))
    last_day = max((c.date for c in buoy.series if c.date), default=None)
    years = list(range(last_day.year, first_day.year - 1, -1)) if first_day and last_day else []
    return templates.TemplateResponse(
        request,
        "buoy.html",
        {
            **page_context(session),
            "buoy": buoy,
            "events": [api.event_out(event) for event in events],
            "years": years,
            "latest": last_day,
        },
    )


@router.get("/about", response_class=HTMLResponse)
def about(request: Request, session: SessionDep):
    return templates.TemplateResponse(request, "about.html", page_context(session))
