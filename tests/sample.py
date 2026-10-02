"""A small synthetic record with every kind of product in it, for the product tests and CI's ERDDAP check.

python -m tests.sample DIRECTORY   # write its products to DIRECTORY
"""

import datetime as dt
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from heatwaves import products
from heatwaves.models import Event, Series
from heatwaves.stations import SourceName, Variable
from heatwaves.sync import update_heatwaves
from tests.conftest import add_series, fresh_database, seasonal_temperatures

END = "2021-06-30"
GAP = slice("2020-03-01", "2020-03-06")  # six days without data at 50 m
SATELLITE_CELL = (42.625, -70.625, 12.7)
# Warm spells at 50 m, each found as a heatwave, with the origin label it's given.
HEATWAVES_AT_50 = {
    ("2020-12-24", "2021-01-07"): "surface",  # across New Year: begun in 2020, overlapping 2021
    ("2021-04-14", "2021-04-28"): "offshore",
    ("2021-06-05", "2021-06-14"): "unclear",
}


def build(session: Session) -> None:
    """A01 at 1 and 50 m, with salinity at 50 m and the satellite.

    50 m has a heatwave in each of HEATWAVES_AT_50, and a gap in March 2020;
    the satellite has one from Apr 1 to 20, 2021.
    """
    at_50 = seasonal_temperatures("2003-01-01", END, seed=1)
    for first, last in HEATWAVES_AT_50:
        at_50[first:last] += 2.5
    at_50 = at_50.drop(at_50[GAP].index)
    satellite = seasonal_temperatures("2003-01-01", END, seed=2)
    satellite["2021-04-01":"2021-04-20"] += 2.5
    # Salinity starts later than temperature and ends later too.
    days = pd.date_range("2005-06-01", "2021-07-15")
    salinity = pd.Series(32 + np.random.default_rng(3).normal(0, 0.1, len(days)), index=days)

    for values, depth, variable, source in (
        (seasonal_temperatures("2003-01-01", END), 1, Variable.TEMPERATURE, SourceName.BUOY),
        (at_50, 50, Variable.TEMPERATURE, SourceName.BUOY),
        (salinity, 50, Variable.SALINITY, SourceName.BUOY),
        (satellite, 0, Variable.TEMPERATURE, SourceName.SATELLITE),
    ):
        update_heatwaves(session, add_series(session, values, "A01", depth, variable, source))
    cell = session.scalars(select(Series).where(Series.source == SourceName.SATELLITE)).one()
    cell.latitude, cell.longitude, cell.distance_km = SATELLITE_CELL
    # heatwaves.origin needs more buoys than this to judge; each label is set as it might set it.
    at_50_id = session.scalar(
        select(Series.id).where(Series.depth == 50, Series.variable == Variable.TEMPERATURE)
    )
    for (first, last), label in HEATWAVES_AT_50.items():
        session.execute(
            update(Event)
            .where(
                Event.series_id == at_50_id,
                Event.start_date <= dt.date.fromisoformat(last),
                Event.end_date >= dt.date.fromisoformat(first),
            )
            .values(origin=label)
        )
    session.commit()


def main(argv: list[str]) -> int:
    with fresh_database() as session_factory, session_factory() as session:
        build(session)
        products.write(session, Path(argv[0]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
