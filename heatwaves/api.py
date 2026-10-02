"""The JSON API. FastAPI serves interactive docs for it at /docs."""

import datetime as dt
import os
from collections import Counter, defaultdict
from pathlib import Path
from typing import Annotated, BinaryIO, Literal, cast

import httpx
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, WebSocket
from fastapi import Path as PathParameter
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import extract, func, select
from sqlalchemy.orm import Session, selectinload
from starlette.types import Receive, Scope, Send

from heatwaves import compare, hobday, live, origin, products, qc, queries, stations
from heatwaves.config import settings
from heatwaves.db import get_session
from heatwaves.models import Buoy, DailyMean, Event, Series
from heatwaves.origin import Origin, Vote
from heatwaves.queries import AT_BUOY, DECIMALS
from heatwaves.sources import connect
from heatwaves.state import OFFLINE_AFTER, State, latest_by_series, state_of
from heatwaves.state import latest as latest_of

router = APIRouter(prefix="/api", tags=["heatwaves"])
SessionDep = Annotated[Session, Depends(get_session)]

# Each series' source builds its data link; the API makes no requests through them.
SOURCES = connect(httpx.Client())

# No record begins before this day; heatwaves.sources reads the satellite from it.
FIRST_DAY = dt.date(2001, 1, 1)

# Parameters bounded so that a wild value is a 422, not a database error.
# Depths are in meters, 0 being the satellite; the deepest sensor is at 250 m.
Depth = Annotated[int, Field(ge=0, le=1000)]
Year = Annotated[int, Field(ge=FIRST_DAY.year, le=2100)]


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
    category: int | None  # of the heatwave in progress or paused (heatwaves.state)
    category_name: str | None
    event_start: dt.date | None
    synced_at: dt.datetime | None  # when the sync job last checked ERDDAP
    reading_at: dt.datetime | None  # newest reading that passed quality control; null for the satellite
    reading: float | None


class SatelliteCondition(Condition):
    """Latest satellite conditions at a buoy (depth 0), and the grid cell they come from."""

    latitude: float | None  # the cell's center
    longitude: float | None
    distance_km: float | None  # from the buoy


class BuoyOut(BaseModel):
    id: str
    name: str
    latitude: float | None
    longitude: float | None
    series: list[Condition]  # buoy depths, shallowest first
    satellite: SatelliteCondition | None


Variable = Literal["temperature", "salinity"]


class Day(BaseModel):
    date: dt.date
    value: float | None  # null when the day has too little data
    climatology: float
    threshold: float
    anomaly: float | None  # value minus climatology


class DayValue(BaseModel):
    """A daily mean alone, without its normal."""

    date: dt.date
    value: float | None  # null when the day has too little data


# Whether a heatwave is over, by its series' state today (heatwaves.state): "ongoing" while the series is in
# it, "paused" while the series is paused on it, else "ended".
EventStatus = Literal["ongoing", "paused", "ended"]


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
    origin: Origin | None  # the origin label; only at the depths heatwaves.origin covers
    status: EventStatus  # unless "ended", all but its start are so far


class Evidence(BaseModel):
    """The signals behind a heatwave's origin (heatwaves.origin), and how each voted. Null without data."""

    salinity_anomaly: float | None  # at the event's depth, mean over the evidence window
    surface_heatwave_days: int | None  # at 1 m, in the 30 days before onset
    stratification_before: float | None  # 1 m minus the event's depth, degrees C, 30 days before
    stratification_after: float | None  # the same, onset to 14 days after
    deep_heatwave_days: int | None  # days M01 was in a heatwave at any of 100-250 m, 30 days before
    offshore_onset: dt.date | None  # first onset at N01 or M01 at this depth, 90 days before
    western_onset: dt.date | None  # the same at A01 or B01; neither counts the event's own buoy
    votes: dict[str, Vote]  # by signal: salinity, surface_heatwave, stratification, deep, onset_order


class SignalDay(BaseModel):
    """One day of the evidence window, for charting each signal."""

    date: dt.date
    anomaly: float | None  # temperature at the event's depth minus normal, degrees C
    salinity_anomaly: float | None
    stratification: float | None  # 1 m minus the event's depth, degrees C
    surface_anomaly: float | None  # at 1 m, degrees C
    surface_heatwave: bool  # at 1 m
    deep_anomaly: float | None  # M01, mean over 100-250 m, degrees C
    deep_heatwave: bool  # M01 at any of 100-250 m


Group = Literal["offshore", "western"]


class Onset(BaseModel):
    buoy_id: str
    date: dt.date
    group: Group | None  # which side of the onset-order signal it counts for; none at the heatwave's own buoy


class EventDetail(EventOut):
    evidence: Evidence | None
    signals: list[SignalDay]  # from 30 days before onset to 14 after; empty without an origin
    onsets: list[Onset]  # every buoy's onsets at this depth in the 90 days to this one


class OriginRules(BaseModel):
    """The thresholds heatwaves.origin labels with."""

    depths: list[int]  # meters: the depths whose heatwaves get a label
    before: int  # days before onset in the evidence window
    after: int  # days after onset in the evidence window
    lookback: int  # days before onset searched for other buoys' onsets
    min_days: int  # days of data a signal needs in its window to vote
    salty: float  # salinity anomaly at or above which the water votes offshore
    fresh: float  # at or below which it votes surface
    drift: float  # below which a salinity sensor is taken to be drifting, and doesn't vote
    mixed: float  # degrees C: 1 m less than this warmer than the depth means an already mixed column
    collapse: float  # the stratification collapses below this fraction of its value before onset
    together: int  # days: onsets this close count as together
    margin: int  # votes a label needs over the other side
    offshore_buoys: list[str]
    western_buoys: list[str]
    deep_buoy: str
    deep_depths: list[int]


class Method(BaseModel):
    """What the pages state the method with.

    Heatwave detection's parameters (heatwaves.hobday), the hours a daily mean needs (heatwaves.qc), when
    a series is offline (heatwaves.state), and the depths the map shows.
    """

    baseline_start: int  # first year of the baseline the normal and threshold come from
    baseline_end: int  # its last year
    percentile: float  # of the baseline's temperatures for the time of year: the threshold
    window_half_width: int  # days either side of each day of the year pooled into its normal and threshold
    smooth_width: int  # days in the running mean that smooths the normal and threshold
    min_duration: int  # days in a row above the threshold that make a heatwave
    max_gap: int  # days: heatwaves this many days apart or fewer are joined into one
    max_pad: int  # days: gaps in the data this long or shorter are filled in; a longer one ends a heatwave
    categories: list[str]  # names, category 1 first (heatwaves.hobday.CATEGORIES)
    min_hours: int  # hours with a reading a day needs for its daily mean (heatwaves.qc)
    offline_after: int  # days: a series whose newest daily mean is older than this is offline
    depths: list[int]  # meters: those every buoy has, which the map shows


class BuoyYear(BaseModel):
    """One buoy's year at one depth: its heatwaves and each day's anomaly."""

    buoy_id: str
    heatwaves: list[EventOut]  # running in the year, oldest first: one carried over from the year before too
    anomaly: list[float | None]  # degrees C above normal, one per day of `Onsets.dates`
    heatwave: list[dt.date | None]  # the start date of the heatwave each day was part of; null outside one


class Onsets(BaseModel):
    year: int
    depth: int
    dates: list[dt.date]
    buoys: list[BuoyYear]


class MonthAnomaly(BaseModel):
    month: dt.date  # its first day
    anomaly: float  # degrees C against normal, averaged over the buoys
    buoys: int  # buoys with at least 15 days of data in the month


class YearSummary(BaseModel):
    buoy_id: str
    depth: int | None  # null: every depth
    year: int
    heatwave_days: int
    observed_days: int


class DataFile(BaseModel):
    format: products.Format
    url: str
    size: int  # bytes
    modified: dt.datetime  # when the sync job last wrote it


class DataProduct(BaseModel):
    """One product, as NetCDF and as CSV."""

    name: str  # the files' name without extension, e.g. A01_heatwaves_020m
    buoy_id: str | None  # null for the events table
    depth: int | None
    files: list[DataFile]


class DataVariable(BaseModel):
    """A variable of the daily series files, from its NetCDF attributes."""

    name: str
    long_name: str
    units: str | None
    standard_name: str | None  # from the CF standard name table, where it has one
    flag_meanings: str | None  # for flags: the meaning of 0, 1, 2 ... in order


class DataCatalog(BaseModel):
    products: list[DataProduct]  # the daily series by buoy and depth, then the events table
    variables: list[DataVariable]


class Agreement(BaseModel):
    """Days in a year with data at both a buoy depth and the satellite, by which saw a heatwave."""

    buoy_id: str
    depth: int
    year: int
    both: int
    satellite_only: int
    buoy_only: int
    neither: int


def now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def today() -> dt.date:
    return now().date()


def _number(value: float) -> float | None:
    """A value for JSON: NaN, pandas' missing value, becomes null."""
    return None if pd.isna(value) else float(value)


def buoy_conditions(session: Session, on: dt.date) -> list[BuoyOut]:
    buoys = session.scalars(select(Buoy).order_by(Buoy.id)).all()
    depths: dict[str, list[Series]] = defaultdict(list)
    temperatures = queries.buoy_temperatures(session)
    for series in temperatures:
        depths[series.buoy_id].append(series)
    satellites = queries.satellite_temperatures(session)
    latest = latest_by_series(session)
    spans = queries.extents(session, [each.id for each in (*temperatures, *satellites.values())])
    first_dates = {series_id: first for series_id, (first, _) in spans.items()}

    def condition(series: Series) -> Condition:
        return describe(series, latest.get(series.id), first_dates.get(series.id), on)

    def satellite(series: Series | None) -> SatelliteCondition | None:
        if series is None:
            return None
        return SatelliteCondition(
            **condition(series).model_dump(),
            latitude=series.latitude,
            longitude=series.longitude,
            distance_km=series.distance_km,
        )

    return [
        BuoyOut(
            id=buoy.id,
            name=buoy.name,
            latitude=buoy.latitude,
            longitude=buoy.longitude,
            series=[condition(series) for series in depths[buoy.id]],
            satellite=satellite(satellites.get(buoy.id)),
        )
        for buoy in buoys
    ]


def describe(series: Series, latest: Event | None, first_date: dt.date | None, on: dt.date) -> Condition:
    """`latest` is the series' most recent heatwave, if any."""
    anomaly = None
    if series.latest_value is not None and series.latest_climatology is not None:
        anomaly = series.latest_value - series.latest_climatology
    state = state_of(series, latest, on).state
    # The heatwave in progress or paused; an offline series still names the one its last day was in.
    ongoing = latest is not None and latest.end_date == series.latest_date
    heatwave = latest if ongoing or state == "paused" else None
    return Condition(
        depth=series.depth,
        dataset_id=series.dataset_id,
        erddap_url=SOURCES[series.source].page_url(series),
        state=state,
        first_date=first_date,
        date=series.latest_date,
        temperature=series.latest_value,
        climatology=series.latest_climatology,
        anomaly=anomaly,
        threshold=series.latest_threshold,
        days_above=series.days_above,
        category=heatwave.category if heatwave else None,
        category_name=heatwave.category_name if heatwave else None,
        event_start=heatwave.start_date if heatwave else None,
        synced_at=series.synced_at,
        reading_at=series.latest_reading_at,
        reading=series.latest_reading,
    )


def get_series(session: Session, buoy_id: str, depth: int, variable: Variable = "temperature") -> Series:
    series = session.scalar(
        select(Series).where(
            Series.variable == variable, Series.buoy_id == buoy_id.upper(), Series.depth == depth
        )
    )
    if series is None:
        raise HTTPException(404, f"No {variable} series for buoy {buoy_id} at {depth} m")
    return series


def event_out(event: Event, latest: Event | None, on: dt.date) -> EventOut:
    """`latest` is the most recent heatwave of the event's series, if any."""
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
        origin=cast(Origin | None, event.origin),
        status=event_status(event, latest, on),
    )


def event_status(event: Event, latest: Event | None, on: dt.date) -> EventStatus:
    """Whether a heatwave is over, as its series' state on `on` has it (heatwaves.state).

    Only the series' most recent heatwave, `latest`, can be "ongoing",
    while the series' state is "heatwave", or "paused", while it's
    "paused". Every other is "ended", the last of a series gone offline
    too: its record stops in it, and it ends there, as a heatwave does at
    a long gap in the record.
    """
    if latest is None or latest.id != event.id:
        return "ended"
    state = state_of(event.series, latest, on).state
    return "ongoing" if state == "heatwave" else "paused" if state == "paused" else "ended"


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
    depth: Depth,
    session: SessionDep,
    start: Annotated[dt.date | None, Field(ge=FIRST_DAY)] = None,
    end: Annotated[dt.date | None, Field(ge=FIRST_DAY)] = None,
    variable: Variable = "temperature",
) -> list[Day]:
    """Daily means of a variable with its climatology and heatwave threshold.

    Temperature is in degrees C and salinity on the practical salinity
    scale, each to 0.001. Depth 0 is the satellite's sea surface temperature
    at the buoy. Defaults to the 365 days ending on the newest observation.
    Days without enough data are included with a null value, so gaps stay
    visible. `start` and `end` must fall between 2001-01-01, before which no
    record begins, and a year from today.
    """
    frame = _daily_frame(session, buoy_id, depth, start, end, variable)
    return [
        Day(
            date=date,
            value=_number(value),
            climatology=climatology,
            threshold=threshold,
            anomaly=_number(anomaly),
        )
        for date, value, climatology, threshold, anomaly in zip(
            pd.DatetimeIndex(frame.index).date,
            frame["value"],
            frame["climatology"],
            frame["threshold"],
            frame["anomaly"],
            strict=True,
        )
    ]


@router.get("/buoys/{buoy_id}/{depth}/daily/values")
def daily_values(
    buoy_id: str,
    depth: Depth,
    session: SessionDep,
    start: Annotated[dt.date | None, Field(ge=FIRST_DAY)] = None,
    end: Annotated[dt.date | None, Field(ge=FIRST_DAY)] = None,
    variable: Variable = "temperature",
) -> list[DayValue]:
    """The daily means of /daily alone, without the climatology, threshold and anomaly.

    It takes the same parameters and has the same days, in about a third of
    the bytes, for charting a whole record at a glance.
    """
    frame = _daily_frame(session, buoy_id, depth, start, end, variable)
    return [
        DayValue(date=date, value=_number(value))
        for date, value in zip(pd.DatetimeIndex(frame.index).date, frame["value"], strict=True)
    ]


def _daily_frame(
    session: Session,
    buoy_id: str,
    depth: int,
    start: dt.date | None,
    end: dt.date | None,
    variable: Variable,
) -> pd.DataFrame:
    """The days /daily and /daily/values serve, from queries.daily, rounded to DECIMALS."""
    series = get_series(session, buoy_id, depth, variable)
    end = end or series.latest_date or today()
    start = start or end - dt.timedelta(days=364)
    if start > end:
        raise HTTPException(422, "start must be on or before end")
    # Every day asked for costs a row, whether or not it has data, so the
    # range is bounded to keep any request to about a full record.
    last = today() + dt.timedelta(days=365)
    if end > last:
        raise HTTPException(422, f"end must be on or before {last}, a year from today")

    frame = queries.daily(session, series.id, start, end)
    if frame is None:
        raise HTTPException(404, f"No climatology yet for {series.label}")
    return frame.round(DECIMALS)


@router.get("/events")
def list_events(
    session: SessionDep,
    buoy_id: str | None = None,
    depth: Depth | None = None,
    year: Year | None = None,
    min_category: Annotated[int, Query(ge=1, le=4)] = 1,
    origin_: Annotated[Origin | None, Query(alias="origin")] = None,
) -> list[EventOut]:
    """Marine heatwaves at the buoys, newest first. `year` matches events overlapping that year."""
    query = (
        select(Event)
        .join(Series)
        .options(selectinload(Event.series))
        .where(AT_BUOY, Event.category >= min_category)
    )
    if buoy_id is not None:
        query = query.where(Series.buoy_id == buoy_id.upper())
    if depth is not None:
        query = query.where(Series.depth == depth)
    if year is not None:
        query = query.where(Event.start_date <= dt.date(year, 12, 31), Event.end_date >= dt.date(year, 1, 1))
    if origin_ is not None:
        query = query.where(Event.origin == origin_)
    latest, on = latest_by_series(session), today()
    return [
        event_out(event, latest.get(event.series_id), on)
        for event in session.scalars(query.order_by(Event.start_date.desc()))
    ]


@router.get("/events/{buoy_id}/{depth}/{start}")
def get_event(buoy_id: str, depth: Depth, start: dt.date, session: SessionDep) -> EventDetail:
    """One heatwave, with the evidence behind its origin label, day by day.

    Heatwaves are addressed by buoy, depth and start date: their database
    IDs change whenever the sync recomputes them.
    """
    event = session.scalar(
        select(Event)
        .join(Series)
        .options(selectinload(Event.series))
        .where(AT_BUOY, Series.buoy_id == buoy_id.upper(), Series.depth == depth, Event.start_date == start)
    )
    if event is None:
        raise HTTPException(404, f"No heatwave at {buoy_id} {depth} m starting {start}")
    out = event_out(event, latest_of(session, event.series), today())
    detail = EventDetail(**out.model_dump(), evidence=None, signals=[], onsets=[])
    if event.evidence is None:
        return detail

    record = queries.origin_record(
        session,
        start - dt.timedelta(days=origin.LOOKBACK),
        start + dt.timedelta(days=origin.AFTER),
        around=[(event.series.buoy_id, depth)],
    )
    signals = origin.signals(record, event.series.buoy_id, depth, start)
    offshore, western = origin.sides(event.series.buoy_id)
    groups: dict[str, Group] = {buoy: "offshore" for buoy in offshore} | {buoy: "western" for buoy in western}
    detail.evidence = Evidence.model_validate(event.evidence)
    detail.signals = [
        SignalDay(
            date=day,
            anomaly=_number(row["anomaly"]),
            salinity_anomaly=_number(row["salinity_anomaly"]),
            stratification=_number(row["stratification"]),
            surface_anomaly=_number(row["surface_anomaly"]),
            surface_heatwave=bool(row["surface_heatwave"]),
            deep_anomaly=_number(row["deep_anomaly"]),
            deep_heatwave=bool(row["deep_heatwave"]),
        )
        for day, row in zip(pd.DatetimeIndex(signals.index).date, signals.to_dict("records"), strict=True)
    ]
    detail.onsets = [
        Onset(buoy_id=buoy, date=date, group=groups.get(buoy))
        for buoy, date in origin.recent_onsets(record, depth, start)
    ]
    return detail


@router.get("/origin/rules")
def origin_rules() -> OriginRules:
    """The thresholds behind every heatwave's origin label."""
    return OriginRules(
        depths=list(origin.DEPTHS),
        before=origin.BEFORE,
        after=origin.AFTER,
        lookback=origin.LOOKBACK,
        min_days=origin.MIN_DAYS,
        salty=origin.SALTY,
        fresh=origin.FRESH,
        drift=origin.DRIFT,
        mixed=origin.MIXED,
        collapse=origin.COLLAPSE,
        together=origin.TOGETHER,
        margin=origin.MARGIN,
        offshore_buoys=list(origin.OFFSHORE_BUOYS),
        western_buoys=list(origin.WESTERN_BUOYS),
        deep_buoy=origin.DEEP_BUOY,
        deep_depths=list(origin.DEEP_DEPTHS),
    )


@router.get("/method")
def method() -> Method:
    """The parameters heatwaves are found with, and the rest the site states its method with.

    The rest: the hours with a reading a day needs for its daily mean, the days after which a series is
    reported offline, and the depths the site's map shows, those every buoy has.
    """
    first, last = stations.BASELINE
    return Method(
        baseline_start=first,
        baseline_end=last,
        percentile=round(hobday.PERCENTILE * 100, 6),
        window_half_width=hobday.WINDOW_HALF_WIDTH,
        smooth_width=hobday.SMOOTH_WIDTH,
        min_duration=hobday.MIN_DURATION,
        max_gap=hobday.MAX_GAP,
        max_pad=hobday.MAX_PAD,
        categories=[hobday.CATEGORIES[category] for category in sorted(hobday.CATEGORIES)],
        min_hours=qc.MIN_HOURS,
        offline_after=OFFLINE_AFTER.days,
        depths=sorted(set.intersection(*(set(depths) for depths in stations.DEPTHS.values()))),
    )


@router.get("/onsets")
def onsets(year: Year, depth: Depth, session: SessionDep) -> Onsets:
    """Every buoy's heatwaves at one depth through a year, for charting that year at every buoy.

    For each buoy with a series at `depth`: its heatwaves running in the
    year, one carried over from the year before or into the next included,
    and for each day the temperature anomaly and the start date of the
    heatwave the day was part of, which with the buoy and depth addresses
    it. At a depth no buoy measures, `buoys` is empty.
    """
    series = queries.buoy_temperatures(session, depth)
    first_day, last_day = dt.date(year, 1, 1), dt.date(year, 12, 31)
    days = pd.date_range(first_day, last_day, name="date")
    running: dict[int, list[Event]] = defaultdict(list)
    latest, on = latest_by_series(session), today()
    for event in session.scalars(
        select(Event)
        .options(selectinload(Event.series))
        .where(
            Event.series_id.in_([each.id for each in series]),
            Event.start_date <= last_day,
            Event.end_date >= first_day,
        )
        .order_by(Event.start_date)
    ):
        running[event.series_id].append(event)

    def buoy_year(each: Series) -> BuoyYear:
        frame = queries.daily(session, each.id, first_day, last_day)
        anomaly = frame["anomaly"].reindex(days) if frame is not None else pd.Series(float("nan"), index=days)
        # Every day of a heatwave, the short gaps detection filled in included.
        start_of = {
            day: event.start_date
            for event in running[each.id]
            for day in pd.date_range(event.start_date, event.end_date).date
        }
        return BuoyYear(
            buoy_id=each.buoy_id,
            heatwaves=[event_out(event, latest.get(each.id), on) for event in running[each.id]],
            anomaly=[_number(value) for value in anomaly],
            heatwave=[start_of.get(day) for day in days.date],
        )

    return Onsets(year=year, depth=depth, dates=list(days.date), buoys=[buoy_year(each) for each in series])


@router.get("/annual")
def annual(
    session: SessionDep,
    depth: Depth | None = None,
    min_category: Annotated[int, Query(ge=1, le=4)] = 1,
    origin_: Annotated[Origin | None, Query(alias="origin")] = None,
) -> list[YearSummary]:
    """Heatwave days and observed days per buoy and year, at one depth or at every depth.

    Heatwave days are days inside the heatwaves /api/events lists for
    `min_category` and `origin`. Without `depth`, a day counts once however
    many depths were in a heatwave, and is observed if any depth had data.
    """
    ids = [each.id for each in queries.buoy_temperatures(session, depth)]
    year = extract("year", DailyMean.date)
    observed = session.execute(
        select(Series.buoy_id, year, func.count(DailyMean.date.distinct()))
        .join(Series)
        .where(Series.id.in_(ids))
        .group_by(Series.buoy_id, year)
    ).all()

    heatwaves = (
        select(Series.buoy_id, Event.start_date, Event.end_date)
        .join(Series)
        .where(Series.id.in_(ids), Event.category >= min_category)
    )
    if origin_ is not None:
        heatwaves = heatwaves.where(Event.origin == origin_)
    # Every day of a heatwave, the short gaps detection filled in included.
    days = {
        (buoy_id, day)
        for buoy_id, start, end in session.execute(heatwaves)
        for day in pd.date_range(start, end).date
    }
    heatwave_days = Counter((buoy_id, day.year) for buoy_id, day in days)

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


@router.get("/stripes")
def stripes(depth: Depth, session: SessionDep) -> list[MonthAnomaly]:
    """Each month's temperature against normal at one depth, averaged over the buoys.

    A buoy counts toward a month with at least 15 days of data in it, against
    its own 2003-2022 normal. Months no buoy counts toward are left out. The
    site draws these as the stripes across its header.
    """
    frames = (queries.daily(session, each.id) for each in queries.buoy_temperatures(session, depth))
    months = queries.monthly_anomaly(frame["anomaly"] for frame in frames if frame is not None)
    return [
        MonthAnomaly(month=month.date(), anomaly=round(anomaly, 3), buoys=int(count))
        for month, anomaly, count in zip(
            pd.DatetimeIndex(months.index), months["anomaly"], months["series"], strict=True
        )
    ]


@router.get("/agreement")
def agreement(depth: Depth, session: SessionDep) -> list[Agreement]:
    """How often the satellite saw the heatwaves at one depth, per buoy and year.

    Compares each buoy's heatwave days at `depth` with the satellite's at the
    surface above it, over the days both have data.
    """
    satellites = queries.satellite_temperatures(session)
    pairs = [
        (each, satellites[each.buoy_id])
        for each in queries.buoy_temperatures(session, depth)
        if each.buoy_id in satellites
    ]
    ids = [each.id for pair in pairs for each in pair]
    observed = queries.observed_days(session, ids)
    heatwaves = queries.heatwave_days(session, ids)

    def flags(series: Series) -> pd.Series:
        return compare.in_heatwave(observed[series.id], heatwaves[series.id])

    rows = []
    for at_depth, above in pairs:
        table = compare.agreement(flags(at_depth), flags(above))
        rows += [
            Agreement(
                buoy_id=at_depth.buoy_id,
                depth=depth,
                year=int(year),
                both=int(both),
                satellite_only=int(satellite_only),
                buoy_only=int(buoy_only),
                neither=int(neither),
            )
            for year, both, satellite_only, buoy_only, neither in table.itertuples()
        ]
    return rows


@router.websocket("/live")
async def live_feed(websocket: WebSocket) -> None:
    """New readings and heatwave changes as they are stored (heatwaves.live), as JSON messages."""
    await live.serve(websocket, live.hub)


def products_dir() -> Path:
    """Where the sync job writes the products; a dependency, so tests can point it elsewhere."""
    return settings.products_dir


ProductsDir = Annotated[Path, Depends(products_dir)]
MEDIA_TYPES: dict[str, str] = {"nc": "application/x-netcdf", "csv": "text/csv; charset=utf-8"}


@router.get("/data")
def data_catalog(directory: ProductsDir) -> DataCatalog:
    """The downloadable products: each buoy depth's daily series and the events table, as NetCDF and CSV."""
    grouped: dict[str, DataProduct] = {}
    for file in products.listing(directory):
        stem = file.path.stem
        product = grouped.setdefault(
            stem, DataProduct(name=stem, buoy_id=file.buoy_id, depth=file.depth, files=[])
        )
        url = (
            f"/api/data/{file.buoy_id}/{file.depth}.{file.format}"
            if file.buoy_id is not None
            else f"/api/data/events.{file.format}"
        )
        product.files.append(DataFile(format=file.format, url=url, size=file.size, modified=file.modified))
    return DataCatalog(
        products=list(grouped.values()),
        variables=[
            DataVariable(
                name=name,
                long_name=attrs["long_name"],
                units=attrs.get("units"),
                standard_name=attrs.get("standard_name"),
                flag_meanings=attrs.get("flag_meanings"),
            )
            for name, attrs in products.DAILY_VARIABLES.items()
        ],
    )


@router.get("/data/events.{format}", response_class=FileResponse)
@router.head("/data/events.{format}", include_in_schema=False)
def download_events(format: products.Format, directory: ProductsDir, request: Request) -> Response:
    """Every heatwave at the buoys: a CF point file, or a CSV with the fields of /api/events but `status`."""
    return _download(products.events_path(directory, format), format, request)


@router.get("/data/{buoy_id}/{depth}.{format}", response_class=FileResponse)
@router.head("/data/{buoy_id}/{depth}.{format}", include_in_schema=False)
def download_daily(
    buoy_id: Annotated[str, PathParameter(pattern=r"^[A-Za-z0-9]{1,8}$")],
    depth: Depth,
    format: products.Format,
    directory: ProductsDir,
    request: Request,
) -> Response:
    """A buoy depth's daily series: a CF time series in NetCDF, or CSV. See /api/data for the variables."""
    return _download(products.daily_path(directory, buoy_id.upper(), depth, format), format, request)


def _download(path: Path, format: products.Format, request: Request) -> Response:
    """The file, with Starlette's ETag and byte ranges, or a 304 if the request has its ETag.

    Like the rest of the API, it's revalidated before a cache reuses it: the
    sync rewrites the files.
    """
    try:
        file = path.open("rb")
    except FileNotFoundError:
        raise HTTPException(
            404, f"No product {path.name}; it appears after the sync job's next run"
        ) from None
    headers = {"Cache-Control": "no-cache"}
    response = OpenFileResponse(file, headers=headers, media_type=MEDIA_TYPES[format], filename=path.name)
    if response.headers["etag"] in if_none_match(request):
        file.close()
        return Response(status_code=304, headers={"ETag": response.headers["etag"], **headers})
    return response


class OpenFileResponse(FileResponse):
    """A FileResponse of a file already open, so its body is the file its headers describe.

    The sync replaces a product with a new file rather than rewriting it, and
    Starlette opens its path again to read the body. Through /dev/fd that is
    the file opened here, even once another has taken its name.
    """

    def __init__(self, file: BinaryIO, headers: dict[str, str], media_type: str, filename: str) -> None:
        super().__init__(
            f"/dev/fd/{file.fileno()}",
            headers=headers,
            media_type=media_type,
            filename=filename,
            stat_result=os.fstat(file.fileno()),
        )
        self.file = file

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            self.file.close()


def if_none_match(request: Request) -> set[str]:
    """The ETags in a request's If-None-Match, without their W/, since it matches weak ones too."""
    return {tag.strip().removeprefix("W/") for tag in request.headers.get("if-none-match", "").split(",")}
