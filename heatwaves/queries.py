"""Reads of the stored record, shared by the API and anything else that reports on it."""

from collections import defaultdict
from collections.abc import Collection

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from heatwaves.models import DailyMean, Event


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


def observed_days(session: Session, series_ids: Collection[int]) -> dict[int, pd.DatetimeIndex]:
    """The days each series has a daily value for."""
    days: dict[int, list] = defaultdict(list)
    for series_id, date in session.execute(
        select(DailyMean.series_id, DailyMean.date).where(DailyMean.series_id.in_(series_ids))
    ):
        days[series_id].append(date)
    return {series_id: pd.DatetimeIndex(sorted(days[series_id]), name="date") for series_id in series_ids}


_NO_DAYS = pd.Series([], index=pd.DatetimeIndex([], name="date"), dtype=int)
