"""The figures the README's "Why" section quotes, from the stored record.

Reads DATABASE_URL, as the app does, and prints each figure with what it
counts, so the README can quote them as of the day it's run. The heatwaves
are the buoys' temperature heatwaves; the satellite's aren't counted. The
last figure is of every normal, the satellite's and salinity's included.

    PYTHONPATH=. uv run python -m scripts.readme_figures
"""

import datetime as dt
import sys
from collections import Counter
from typing import get_args

import numpy as np
import pandas as pd
from sqlalchemy import select
from sqlalchemy.engine import Row
from sqlalchemy.orm import Session

from heatwaves import api, origin, queries
from heatwaves.hobday import WINDOW_HALF_WIDTH, day_of_year
from heatwaves.models import DailyMean, Event, Series
from heatwaves.stations import BASELINE

LABELED = origin.DEPTHS  # the depths whose heatwaves get an origin label
AT_LABELED = " and ".join([", ".join(map(str, LABELED[:-1])), str(LABELED[-1])])  # "20 and 50"
LABEL_YEARS = (2021, 2012)
DAYS_YEAR = 2021
DAYS_DEPTHS = (1, 20, 50)


def heatwaves(session: Session) -> list[Row]:
    """Every buoy heatwave: buoy, depth, first and last day, and origin label."""
    return list(
        session.execute(
            select(Series.buoy_id, Series.depth, Event.start_date, Event.end_date, Event.origin)
            .join(Series)
            .where(queries.AT_BUOY)
            .order_by(Event.start_date)
        )
    )


def satellite_misses(session: Session, depth: int) -> tuple[int, int]:
    """Of the buoys' heatwave days at `depth` on which the satellite had data, how many it showed none on.

    Pooled over every buoy with a satellite series, as /api/agreement counts them.
    """
    rows = api.agreement(depth, session)
    missed = sum(row.buoy_only for row in rows)
    return missed, missed + sum(row.both for row in rows)


def days(event: Row) -> int:
    return (event.end_date - event.start_date).days + 1


def fewest_baseline_years(session: Session) -> tuple[int, str]:
    """The fewest baseline years any series with a normal has data in, for any calendar day's window.

    hobday.climatology pools each calendar day's WINDOW_HALF_WIDTH days either
    side across the baseline years; this counts the years with any data in
    that window. With the series it's fewest for.
    """
    first, last = BASELINE
    fewest: tuple[int, str] = (last - first + 1, "")
    for series in session.scalars(select(Series).where(Series.latest_climatology.is_not(None))):
        dates = session.scalars(
            select(DailyMean.date).where(
                DailyMean.series_id == series.id,
                DailyMean.value.is_not(None),
                DailyMean.date.between(dt.date(first, 1, 1), dt.date(last, 12, 31)),
            )
        ).all()
        index = pd.DatetimeIndex(list(dates))
        calendar_day, year = day_of_year(index), index.year.to_numpy()
        for day in range(1, 367):
            apart = np.abs(calendar_day - day)
            years = len(np.unique(year[np.minimum(apart, 366 - apart) <= WINDOW_HALF_WIDTH]))
            if years < fewest[0]:
                fewest = (years, series.label)
    return fewest


def figures(session: Session) -> list[str]:
    """Each figure as a line of text."""
    lines = []
    for depth in (50, 1):
        missed, total = satellite_misses(session, depth)
        share = f"{missed / total:.0%}" if total else "n/a"
        lines.append(
            f"Satellite showed no heatwave on {share} of the {total:,} heatwave days"
            f" at {depth} m ({missed:,})."
        )

    all_events = heatwaves(session)
    labeled = [event for event in all_events if event.depth in LABELED]
    for year in LABEL_YEARS:
        began = [event for event in labeled if event.start_date.year == year]
        origins = Counter(event.origin for event in began)
        counts = ", ".join(f"{origins[label]} {label}" for label in get_args(origin.Origin))
        lines.append(f"Heatwaves at {AT_LABELED} m that began in {year}: {len(began)}; {counts}.")
    judged = [event for event in labeled if event.origin is not None]
    unclear = sum(event.origin == "unclear" for event in judged)
    share = f"{unclear / len(judged):.0%}" if judged else "n/a"
    lines.append(f"Unclear: {share} of the {len(judged)} labeled heatwaves at {AT_LABELED} m ({unclear}).")

    for depth in DAYS_DEPTHS:
        began = [event for event in all_events if event.depth == depth and event.start_date.year == DAYS_YEAR]
        total = sum(days(event) for event in began)
        lines.append(
            f"Heatwaves that began in {DAYS_YEAR} at {depth} m lasted {total:,} days, summed over the buoys."
        )

    for event in sorted(all_events, key=days, reverse=True)[:3]:
        lines.append(
            f"Long heatwave: {days(event)} days at {event.depth} m at {event.buoy_id},"
            f" {event.start_date} to {event.end_date}."
        )

    years, label = fewest_baseline_years(session)
    lines.append(f"Fewest baseline years behind any normal, at any time of year: {years}, for {label}.")
    return lines


def main() -> int:
    from heatwaves.db import SessionLocal

    with SessionLocal() as session:
        print(f"As of {dt.date.today()}:")
        for line in figures(session):
            print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
