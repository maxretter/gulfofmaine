"""The JSON API. FastAPI serves interactive docs for it at /docs."""

import datetime as dt
from collections import Counter
from typing import Annotated, Literal

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import extract, func, select
from sqlalchemy.orm import Session, selectinload

from heatwaves.config import settings
from heatwaves.db import get_session
from heatwaves.hobday import day_of_year
from heatwaves.models import Buoy, ClimatologyDay, DailyMean, Event, Series

router = APIRouter(prefix="/api", tags=["heatwaves"])
SessionDep = Annotated[Session, Depends(get_session)]

# A series whose newest daily mean is older than this is reported offline.
OFFLINE_AFTER = dt.timedelta(days=3)

State = Literal["heatwave", "above_threshold", "normal", "offline", "no_data"]


class Condition(BaseModel):
    """Latest conditions at one depth."""

    depth: int
    dataset_id: str
    erddap_url: str
    state: State
    first_date: dt.date | None  # first day with data
    date: dt.date | None  # most recent day with data
    temperature: float | None
    climatology: float | None
    anomaly: float | None  # temperature minus climatology
    threshold: float | None
    days_above: int  # consecutive days above the threshold, ending on `date`
    category: int | None  # of the heatwave in progress
    category_name: str | None
    event_start: dt.date | None
    synced_at: dt.datetime | None  # when the sync job last checked ERDDAP


class BuoyOut(BaseModel):
    id: str
    name: str
    latitude: float | None
    longitude: float | None
    series: list[Condition]


class Day(BaseModel):
    date: dt.date
    temperature: float | None  # null when the day has too little data
    climatology: float
    threshold: float


class EventOut(BaseModel):
    buoy_id: str
    depth: int
    start_date: dt.date
    end_date: dt.date
    peak_date: dt.date
    duration: int
    max_intensity: float
    mean_intensity: float
    category: int
    category_name: str


class YearSummary(BaseModel):
    buoy_id: str
    depth: int
    year: int
    heatwave_days: int
    observed_days: int


def now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def today() -> dt.date:
    return now().date()


def buoy_conditions(session: Session, on: dt.date) -> list[BuoyOut]:
    buoys = session.scalars(select(Buoy).options(selectinload(Buoy.series)).order_by(Buoy.id)).all()
    ongoing = {
        event.series_id: event
        for event in session.scalars(select(Event).join(Series).where(Event.end_date == Series.latest_date))
    }
    first_dates = dict(
        session.execute(
            select(DailyMean.series_id, func.min(DailyMean.date)).group_by(DailyMean.series_id)
        ).all()
    )
    return [
        BuoyOut(
            id=buoy.id,
            name=buoy.name,
            latitude=buoy.latitude,
            longitude=buoy.longitude,
            series=[
                describe(series, ongoing.get(series.id), first_dates.get(series.id), on)
                for series in buoy.series
            ],
        )
        for buoy in buoys
    ]


def describe(series: Series, ongoing: Event | None, first_date: dt.date | None, on: dt.date) -> Condition:
    if series.latest_date is None:
        state = "no_data"
    elif on - series.latest_date > OFFLINE_AFTER:
        state = "offline"
    elif ongoing is not None:
        state = "heatwave"
    elif series.days_above:
        state = "above_threshold"
    else:
        state = "normal"

    anomaly = None
    if series.latest_value is not None and series.latest_climatology is not None:
        anomaly = series.latest_value - series.latest_climatology
    return Condition(
        depth=series.depth,
        dataset_id=series.dataset_id,
        erddap_url=f"{settings.erddap_url}/tabledap/{series.dataset_id}.html",
        state=state,
        first_date=first_date,
        date=series.latest_date,
        temperature=series.latest_value,
        climatology=series.latest_climatology,
        anomaly=anomaly,
        threshold=series.latest_threshold,
        days_above=series.days_above,
        category=ongoing.category if ongoing else None,
        category_name=ongoing.category_name if ongoing else None,
        event_start=ongoing.start_date if ongoing else None,
        synced_at=series.synced_at,
    )


def get_series(session: Session, buoy_id: str, depth: int) -> Series:
    series = session.scalar(select(Series).where(Series.buoy_id == buoy_id.upper(), Series.depth == depth))
    if series is None:
        raise HTTPException(404, f"No series for buoy {buoy_id} at {depth} m")
    return series


def event_out(event: Event) -> EventOut:
    return EventOut(
        buoy_id=event.series.buoy_id,
        depth=event.series.depth,
        start_date=event.start_date,
        end_date=event.end_date,
        peak_date=event.peak_date,
        duration=event.duration,
        max_intensity=event.max_intensity,
        mean_intensity=event.mean_intensity,
        category=event.category,
        category_name=event.category_name,
    )


@router.get("/buoys")
def list_buoys(session: SessionDep) -> list[BuoyOut]:
    """Every buoy, with the latest conditions at each depth."""
    return buoy_conditions(session, today())


@router.get("/buoys/{buoy_id}")
def get_buoy(buoy_id: str, session: SessionDep) -> BuoyOut:
    for buoy in buoy_conditions(session, today()):
        if buoy.id == buoy_id.upper():
            return buoy
    raise HTTPException(404, f"No buoy {buoy_id}")


@router.get("/buoys/{buoy_id}/{depth}/daily")
def daily(
    buoy_id: str,
    depth: int,
    session: SessionDep,
    start: dt.date | None = None,
    end: dt.date | None = None,
) -> list[Day]:
    """Daily mean temperature with its climatology and heatwave threshold.

    Defaults to the 365 days ending on the newest observation. Days without
    enough data are included with a null temperature, so gaps stay visible.
    """
    series = get_series(session, buoy_id, depth)
    end = end or series.latest_date or today()
    start = start or end - dt.timedelta(days=364)
    if start > end:
        raise HTTPException(422, "start must be on or before end")

    climatology = {
        row.day_of_year: row
        for row in session.scalars(select(ClimatologyDay).where(ClimatologyDay.series_id == series.id))
    }
    if not climatology:
        raise HTTPException(404, f"No climatology yet for {series.dataset_id}")
    temperatures = dict(
        session.execute(
            select(DailyMean.date, DailyMean.value).where(
                DailyMean.series_id == series.id, DailyMean.date.between(start, end)
            )
        ).all()
    )

    days = pd.date_range(start, end, freq="D")
    return [
        Day(
            date=date,
            temperature=temperatures.get(date),
            climatology=climatology[doy].mean,
            threshold=climatology[doy].threshold,
        )
        for date, doy in zip(days.date, day_of_year(days), strict=True)
    ]


@router.get("/events")
def list_events(
    session: SessionDep,
    buoy_id: str | None = None,
    depth: int | None = None,
    year: int | None = None,
    min_category: Annotated[int, Query(ge=1, le=4)] = 1,
) -> list[EventOut]:
    """Marine heatwaves, newest first. `year` matches events overlapping that year."""
    query = (
        select(Event).join(Series).options(selectinload(Event.series)).where(Event.category >= min_category)
    )
    if buoy_id is not None:
        query = query.where(Series.buoy_id == buoy_id.upper())
    if depth is not None:
        query = query.where(Series.depth == depth)
    if year is not None:
        query = query.where(Event.start_date <= dt.date(year, 12, 31), Event.end_date >= dt.date(year, 1, 1))
    return [event_out(event) for event in session.scalars(query.order_by(Event.start_date.desc()))]


@router.get("/annual")
def annual(depth: int, session: SessionDep) -> list[YearSummary]:
    """Heatwave days and observed days per buoy and year, at one depth."""
    year = extract("year", DailyMean.date)
    observed = session.execute(
        select(Series.buoy_id, year, func.count())
        .join(Series)
        .where(Series.depth == depth)
        .group_by(Series.buoy_id, year)
    ).all()

    heatwave_days: Counter[tuple[str, int]] = Counter()
    events = session.scalars(
        select(Event).join(Series).options(selectinload(Event.series)).where(Series.depth == depth)
    )
    for event in events:
        for offset in range(event.duration):
            heatwave_days[event.series.buoy_id, (event.start_date + dt.timedelta(days=offset)).year] += 1

    return [
        YearSummary(
            buoy_id=buoy_id,
            depth=depth,
            year=int(year),
            heatwave_days=heatwave_days[buoy_id, int(year)],
            observed_days=count,
        )
        for buoy_id, year, count in sorted(observed)
    ]
