"""A small synthetic record with every kind of product in it, for the product tests and CI's ERDDAP check.

python -m tests.sample DIRECTORY   # write its products to DIRECTORY
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from heatwaves import products
from heatwaves.models import Event, Series
from heatwaves.sync import update_heatwaves
from tests.conftest import add_series, fresh_database, seasonal_temperatures

END = "2021-06-30"
GAP = slice("2020-03-01", "2020-03-06")  # six days without data at 50 m
SATELLITE_CELL = (42.625, -70.625, 12.7)


def build(session: Session) -> None:
    """A01 at 1 and 50 m, with salinity at 50 m and the satellite.

    50 m has a heatwave from about Apr 14 to 28, 2021, labelled offshore, and
    a gap in March 2020; the satellite has one from Apr 1 to 20, 2021.
    """
    at_50 = seasonal_temperatures("2003-01-01", END, seed=1)
    at_50["2021-04-14":"2021-04-28"] += 2.5
    at_50 = at_50.drop(at_50[GAP].index)
    satellite = seasonal_temperatures("2003-01-01", END, seed=2)
    satellite["2021-04-01":"2021-04-20"] += 2.5
    # Salinity starts later than temperature and ends later too.
    days = pd.date_range("2005-06-01", "2021-07-15")
    salinity = pd.Series(32 + np.random.default_rng(3).normal(0, 0.1, len(days)), index=days)

    for values, depth, variable, source in (
        (seasonal_temperatures("2003-01-01", END), 1, "temperature", "buoy"),
        (at_50, 50, "temperature", "buoy"),
        (salinity, 50, "salinity", "buoy"),
        (satellite, 0, "temperature", "satellite"),
    ):
        update_heatwaves(session, add_series(session, values, "A01", depth, variable, source))
    cell = session.scalars(select(Series).where(Series.source == "satellite")).one()
    cell.latitude, cell.longitude, cell.distance_km = SATELLITE_CELL
    # heatwaves.origin needs more buoys than this to judge; its label is set as it would set it.
    at_50_id = session.scalar(select(Series.id).where(Series.depth == 50, Series.variable == "temperature"))
    session.execute(update(Event).where(Event.series_id == at_50_id).values(origin="offshore"))
    session.commit()


def main(argv: list[str]) -> int:
    with fresh_database() as session_factory, session_factory() as session:
        build(session)
        products.write(session, Path(argv[0]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
