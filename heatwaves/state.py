"""A series' state on a day: in a heatwave, paused, above the threshold, normal, without a normal, or offline.

The API reports it for every series, and the sync compares it before and
after each update so the live feed (heatwaves.live) can announce changes.

The state is of the newest day: "heatwave" while a heatwave ends on it.
Detection joins a spell above the threshold to the heatwave before it if
at most hobday.MAX_GAP days lie between them, once the spell has lasted
hobday.MIN_DURATION days (hobday.detect_events). So after a heatwave's last
day, the state is "paused", with that heatwave's category and dates, for as
long as what follows could still be joined to it (could_resume): while the
newest day isn't above the threshold, or ends a run above it shorter than
MIN_DURATION days, and at most MAX_GAP days lie between the heatwave's last
day and that run's first (with no run, through the newest day, as one
could start the day after). With hobday's parameters, that is a dip of one
or two days, then up to four days back above. Should the run reach
MIN_DURATION days, detection joins it on, and the state is "heatwave"
again, of the same heatwave, with the same start. Once a join can't
happen, the state is "above_threshold" or "normal".

The newest day can be the current UTC day, from about 18:00 UTC, when it
has the hours qc.MIN_HOURS asks for. Its mean is of the hours so far until
the rest are read, so near the threshold the state can change on part of a
day, and again once the day is complete.
"""

import datetime as dt
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from heatwaves.hobday import MAX_GAP
from heatwaves.models import Event, Series

# A series whose newest daily mean is older than this is reported offline.
OFFLINE_AFTER = dt.timedelta(days=3)

State = Literal["heatwave", "paused", "above_threshold", "normal", "no_normal", "offline", "no_data"]


@dataclass(frozen=True)
class SeriesState:
    state: State
    category: int | None  # of the heatwave in progress or paused
    # The rest of that heatwave as the API lists it: start, end and peak dates, max and mean intensity,
    # so that a sync comparing states also announces a heatwave that grows a day or changes.
    heatwave: tuple[dt.date, dt.date, dt.date, float, float] | None = None


def state_of(series: Series, latest: Event | None, on: dt.date) -> SeriesState:
    """`latest` is the series' most recent heatwave, if any."""
    if series.latest_date is None:
        return SeriesState("no_data", None)
    if on - series.latest_date > OFFLINE_AFTER:
        return SeriesState("offline", None)
    if series.latest_climatology is None:
        # Too little data in the baseline for a normal, so no threshold either:
        # neither in a heatwave nor out of one.
        return SeriesState("no_normal", None)
    if latest is not None:
        heatwave = (
            latest.start_date,
            latest.end_date,
            latest.peak_date,
            latest.max_intensity,
            latest.mean_intensity,
        )
        if latest.end_date == series.latest_date:
            return SeriesState("heatwave", latest.category, heatwave)
        if could_resume(latest.end_date, series.latest_date, series.days_above):
            return SeriesState("paused", latest.category, heatwave)
    if series.days_above:
        return SeriesState("above_threshold", None)
    return SeriesState("normal", None)


def could_resume(end: dt.date, newest: dt.date, days_above: int) -> bool:
    """Whether a run above the threshold going on from `newest` would be joined to a heatwave ending on `end`.

    The run is the `days_above` days ending on `newest`, or with none, one
    from the day after. Detection joins it to the heatwave once it lasts
    hobday.MIN_DURATION days, if at most MAX_GAP days lie between the heatwave's
    last day and the run's first. While the heatwave ends before `newest`,
    the run is shorter than that: one as long would have been joined to it
    already, or be a heatwave of its own.
    """
    return (newest - end).days - days_above <= MAX_GAP


def latest(session: Session, series: Series) -> Event | None:
    """The series' most recent heatwave, if any."""
    return session.scalar(
        select(Event).where(Event.series_id == series.id).order_by(Event.end_date.desc()).limit(1)
    )


def latest_by_series(session: Session) -> dict[int, Event]:
    """Every series' most recent heatwave, by series ID; none for a series without one."""
    last = (
        select(Event.series_id, func.max(Event.end_date).label("end_date"))
        .group_by(Event.series_id)
        .subquery()
    )
    events = session.scalars(
        select(Event).join(last, (Event.series_id == last.c.series_id) & (Event.end_date == last.c.end_date))
    )
    return {event.series_id: event for event in events}


def current(session: Session, series: Series, on: dt.date) -> SeriesState:
    return state_of(series, latest(session, series), on)
