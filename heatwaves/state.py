"""A series' state on a given day: in a heatwave, above the threshold, normal, without a normal, or offline.

The API reports it for every series, and the sync compares it before and
after each update so the live feed (heatwaves.live) can announce changes.
"""

import datetime as dt
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from heatwaves.models import Event, Series

# A series whose newest daily mean is older than this is reported offline.
OFFLINE_AFTER = dt.timedelta(days=3)

State = Literal["heatwave", "above_threshold", "normal", "no_normal", "offline", "no_data"]


@dataclass(frozen=True)
class SeriesState:
    state: State
    category: int | None  # of the heatwave in progress
    # The rest of that heatwave as the API lists it: start, end and peak dates, max and mean intensity,
    # so that a sync comparing states also announces a heatwave that grows a day or changes.
    heatwave: tuple[dt.date, dt.date, dt.date, float, float] | None = None


def state_of(series: Series, ongoing: Event | None, on: dt.date) -> SeriesState:
    """`ongoing` is the series' heatwave that runs to its newest day, if any."""
    if series.latest_date is None:
        return SeriesState("no_data", None)
    if on - series.latest_date > OFFLINE_AFTER:
        return SeriesState("offline", None)
    if series.latest_climatology is None:
        # Too little data in the baseline for a normal, so no threshold either:
        # neither in a heatwave nor out of one.
        return SeriesState("no_normal", None)
    if ongoing is not None:
        heatwave = (
            ongoing.start_date,
            ongoing.end_date,
            ongoing.peak_date,
            ongoing.max_intensity,
            ongoing.mean_intensity,
        )
        return SeriesState("heatwave", ongoing.category, heatwave)
    if series.days_above:
        return SeriesState("above_threshold", None)
    return SeriesState("normal", None)


def ongoing(session: Session, series: Series) -> Event | None:
    """The series' heatwave that runs to its newest day, if any."""
    if series.latest_date is None:
        return None
    return session.scalar(
        select(Event).where(Event.series_id == series.id, Event.end_date == series.latest_date)
    )


def current(session: Session, series: Series, on: dt.date) -> SeriesState:
    return state_of(series, ongoing(session, series), on)
