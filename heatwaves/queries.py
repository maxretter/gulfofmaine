"""Reads of the stored record, shared by the API and anything else that reports on it."""

import datetime as dt
from collections import defaultdict
from collections.abc import Collection, Iterable

import pandas as pd
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from heatwaves import origin
from heatwaves.hobday import day_of_year
from heatwaves.models import ClimatologyDay, DailyMean, Event, Series

# Temperature at a buoy depth: the series every heatwave the API lists comes
# from. The satellite's are at depth 0 over each buoy (heatwaves.stations),
# and appear only where named.
AT_BUOY = (Series.source == "buoy") & (Series.variable == "temperature")
SATELLITE = (Series.source == "satellite") & (Series.variable == "temperature")


def buoy_temperatures(session: Session, depth: int | None = None) -> list[Series]:
    """The buoys' temperature series at `depth`, or at every depth, by buoy and then depth.

    None at depth 0: that is the satellite's, from `satellite_temperatures`.
    """
    query = select(Series).where(AT_BUOY)
    if depth is not None:
        query = query.where(Series.depth == depth)
    return list(session.scalars(query.order_by(Series.buoy_id, Series.depth)))


def satellite_temperatures(session: Session) -> dict[str, Series]:
    """The satellite's temperature series over each buoy, by buoy."""
    return {each.buoy_id: each for each in session.scalars(select(Series).where(SATELLITE))}


def daily(
    session: Session, series_id: int, start: dt.date | None = None, end: dt.date | None = None
) -> pd.DataFrame | None:
    """A series' daily values beside their climatology, heatwave threshold and anomaly.

    Every day from `start` to `end` has a row, indexed by day; days without
    a value keep it as NaN. Gaps aren't filled here: only heatwave detection
    interpolates. `start` and `end` default to the first and last days with
    data. None if the series has no climatology yet.
    """
    climatology = pd.DataFrame(
        session.execute(
            select(ClimatologyDay.day_of_year, ClimatologyDay.mean, ClimatologyDay.threshold).where(
                ClimatologyDay.series_id == series_id
            )
        ).all(),
        columns=["day_of_year", "climatology", "threshold"],
    ).set_index("day_of_year")
    if climatology.empty:
        return None

    query = select(DailyMean.date, DailyMean.value).where(DailyMean.series_id == series_id)
    if start is not None:
        query = query.where(DailyMean.date >= start)
    if end is not None:
        query = query.where(DailyMean.date <= end)
    rows = session.execute(query.order_by(DailyMean.date)).all()
    values = pd.Series([row.value for row in rows], index=pd.DatetimeIndex([row.date for row in rows]))

    if start is None and end is None and values.empty:
        days = pd.DatetimeIndex([], name="date")
    else:
        days = pd.date_range(start or values.index.min(), end or values.index.max(), freq="D", name="date")
    frame = climatology.reindex(day_of_year(days)).set_index(days)
    frame.insert(0, "value", values.reindex(days).astype(float))
    frame["anomaly"] = frame["value"] - frame["climatology"]
    return frame


def heatwave_days(session: Session, series_ids: Collection[int]) -> dict[int, pd.Series]:
    """Each series' heatwave days: the category of the heatwave on each, indexed by day.

    Every day of every event counts, including the short gaps inside one
    that detection filled in.
    """
    spans: dict[int, list[pd.Series]] = defaultdict(list)
    for series_id, start, end, category in session.execute(
        select(Event.series_id, Event.start_date, Event.end_date, Event.category).where(
            Event.series_id.in_(series_ids)
        )
    ):
        spans[series_id].append(pd.Series(category, index=pd.date_range(start, end, name="date")))
    return {
        series_id: pd.concat(spans[series_id]).sort_index() if spans[series_id] else _NO_DAYS
        for series_id in series_ids
    }


def monthly_anomaly(anomalies: Iterable[pd.Series], min_days: int = 15) -> pd.DataFrame:
    """Each month's anomaly averaged over the series, from each series' daily anomalies.

    A series counts toward a month with at least `min_days` days of data in
    it; months no series counts toward are left out. Indexed by each month's
    first day, with the mean `anomaly` and the number of `series` behind it.
    """
    means = []
    for daily_anomaly in anomalies:
        months = daily_anomaly.dropna().resample("MS")
        means.append(months.mean()[months.count() >= min_days])
    if not means:
        return pd.DataFrame({"anomaly": [], "series": []}, index=pd.DatetimeIndex([], name="month"))
    table = pd.concat(means, axis=1)
    frame = pd.DataFrame({"anomaly": table.mean(axis=1), "series": table.count(axis=1)})
    frame.index.name = "month"
    return frame[frame["series"] > 0].sort_index()


def observed_days(session: Session, series_ids: Collection[int]) -> dict[int, pd.DatetimeIndex]:
    """The days each series has a daily value for."""
    days: dict[int, list] = defaultdict(list)
    for series_id, date in session.execute(
        select(DailyMean.series_id, DailyMean.date).where(DailyMean.series_id.in_(series_ids))
    ):
        days[series_id].append(date)
    return {series_id: pd.DatetimeIndex(sorted(days[series_id]), name="date") for series_id in series_ids}


def extents(session: Session, series_ids: Collection[int]) -> dict[int, tuple[dt.date, dt.date]]:
    """Each series' first and last days with data. Series without any are left out.

    Two lookups per series on daily_mean's key, rather than a scan of the table.
    """
    first = select(func.min(DailyMean.date)).where(DailyMean.series_id == Series.id).scalar_subquery()
    last = select(func.max(DailyMean.date)).where(DailyMean.series_id == Series.id).scalar_subquery()
    return {
        series_id: (first_day, last_day)
        for series_id, first_day, last_day in session.execute(
            select(Series.id, first, last).where(Series.id.in_(series_ids))
        )
        if first_day is not None
    }


def origin_record(
    session: Session, start: dt.date | None = None, end: dt.date | None = None
) -> origin.Record:
    """Every buoy series the origins of heatwaves are judged from, from `start` to `end`.

    The whole record by default. Either way each series' frame begins and ends
    where its data do, so a window within `start` to `end` holds the same days
    as in the whole record, and a mean over it comes to the same bits.
    Heatwave days are always complete.
    """
    series = session.scalars(select(Series).where(Series.source == "buoy")).all()
    spans = extents(session, [each.id for each in series])
    frames = {each.id: _within(daily(session, each.id, start, end), spans.get(each.id)) for each in series}
    temperatures = [each for each in series if each.variable == "temperature"]
    days = heatwave_days(session, [each.id for each in temperatures])
    return origin.Record(
        temperature={
            (each.buoy_id, each.depth): frame
            for each in temperatures
            if (frame := frames[each.id]) is not None
        },
        salinity={
            (each.buoy_id, each.depth): frame
            for each in series
            if each.variable == "salinity" and (frame := frames[each.id]) is not None
        },
        heatwave_days={(each.buoy_id, each.depth): days[each.id] for each in temperatures},
    )


def _within(frame: pd.DataFrame | None, span: tuple[dt.date, dt.date] | None) -> pd.DataFrame | None:
    """The days of a frame from `daily` between a series' first and last days with data, if any."""
    if frame is None:
        return None
    if span is None:
        return frame.iloc[:0]
    return frame.loc[pd.Timestamp(span[0]) : pd.Timestamp(span[1])]


_NO_DAYS = pd.Series([], index=pd.DatetimeIndex([], name="date"), dtype=int)
