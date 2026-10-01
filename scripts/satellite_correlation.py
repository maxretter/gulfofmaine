"""How closely the buoys' 1 m temperatures follow the satellite's, day by day.

Reads the stored record from DATABASE_URL, as the app does, and prints for
each buoy, and for every buoy pooled, the correlation between its daily
mean at 1 m and the satellite's in its grid cell, over the days both have
data: of the temperatures themselves, which the seasons dominate, and of
the anomalies, each series' temperature less its own 2003-2022 normal.

    PYTHONPATH=. uv run scripts/satellite_correlation.py
"""

import sys

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from heatwaves import queries
from heatwaves.models import Series

DEPTH = 1  # meters: the buoys' depth nearest the surface


def paired_days(session: Session, depth: int = DEPTH) -> dict[str, pd.DataFrame]:
    """By buoy, the days both the buoy at `depth` and the satellite have data.

    Columns: `buoy` and `satellite`, their daily temperatures, and
    `buoy_anomaly` and `satellite_anomaly`, each against its own normal.
    Buoys without both series, or without a normal for either, are left out.
    """
    series = session.scalars(
        select(Series).where(
            Series.variable == "temperature",
            ((Series.source == "buoy") & (Series.depth == depth)) | (Series.source == "satellite"),
        )
    ).all()
    frames: dict[str, dict[str, pd.DataFrame]] = {}
    for each in series:
        frame = queries.daily(session, each.id)
        if frame is not None:
            frames.setdefault(each.buoy_id, {})[each.source] = frame
    pairs = {}
    for buoy_id, by_source in sorted(frames.items()):
        if "buoy" in by_source and "satellite" in by_source:
            buoy, satellite = by_source["buoy"], by_source["satellite"]
            pairs[buoy_id] = pd.DataFrame(
                {
                    "buoy": buoy["value"],
                    "satellite": satellite["value"],
                    "buoy_anomaly": buoy["anomaly"],
                    "satellite_anomaly": satellite["anomaly"],
                }
            ).dropna()
    return pairs


def correlations(pairs: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Per buoy and pooled ("all"): the days compared, and the correlations of temperature and anomaly."""
    rows = {**pairs, "all": pd.concat(pairs.values())} if pairs else {}
    return pd.DataFrame(
        {
            "days": [len(days) for days in rows.values()],
            "temperature": [days["buoy"].corr(days["satellite"]) for days in rows.values()],
            "anomaly": [days["buoy_anomaly"].corr(days["satellite_anomaly"]) for days in rows.values()],
        },
        index=pd.Index(list(rows), name="buoy"),
    )


def main() -> int:
    from heatwaves.db import SessionLocal

    with SessionLocal() as session:
        table = correlations(paired_days(session))
    if table.empty:
        print(f"No buoy has both a temperature record at {DEPTH} m with a normal and the satellite's.")
        return 1
    print(f"Daily correlation of the buoys at {DEPTH} m with the satellite, on the days both have data:")
    print(table.to_string(float_format="{:.3f}".format))
    return 0


if __name__ == "__main__":
    sys.exit(main())
