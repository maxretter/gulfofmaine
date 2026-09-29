"""Quality control and daily averaging of raw buoy readings.

Every variable in the UMaine datasets on NERACOOS ERDDAP carries two flags:
UMaine's own ({variable}_qc) and the QARTOD aggregate ({variable}_qc_agg).
Readings either flag marks as bad are dropped before averaging, so the same
functions serve temperature, salinity or any other variable.
"""

from collections.abc import Iterable

import pandas as pd
import xarray as xr

MIN_HOURS = 18  # hourly bins a day needs for its mean to count

# UMaine's flag uses 0 for quality_good. The QARTOD aggregate flag uses
# 3 for suspect and 4 for fail.
GOOD_UMAINE_FLAG = 0
BAD_QARTOD_FLAGS = [3, 4]


def columns(variables: Iterable[str]) -> list[str]:
    """The ERDDAP columns to request for these variables: time, then each with its two flags."""
    names = ["time"]
    for variable in variables:
        names += [variable, *flags(variable)]
    return names


def flags(variable: str) -> tuple[str, str]:
    return f"{variable}_qc", f"{variable}_qc_agg"


def good_readings(ds: xr.Dataset, variable: str = "temperature") -> pd.Series:
    """One variable's readings from a raw ERDDAP tabledap response, less those either flag marks as bad.

    `ds` has a single `row` dimension holding `time`, the variable and its
    two flags. Returns the readings indexed by time, oldest first.
    """
    umaine, qartod = flags(variable)
    ds = ds.set_coords("time").swap_dims(row="time")
    good = (ds[umaine] == GOOD_UMAINE_FLAG) & ~ds[qartod].isin(BAD_QARTOD_FLAGS)
    return ds[variable].where(good).dropna("time").to_series().sort_index()


def daily_means(readings: pd.Series, min_hours: int = MIN_HOURS) -> pd.DataFrame:
    """Daily means of good readings (from `good_readings`).

    Readings are averaged into hourly bins before the daily mean, so that a
    day's value doesn't depend on the sampling rate, which has been hourly
    and half-hourly over the buoys' history. Days with fewer than
    `min_hours` hourly bins are left out.

    Returns a frame indexed by UTC day, with `value` and `hours` columns.
    """
    # Resampled in pandas: for one long 1-D series it is about a thousand
    # times faster than xarray's resample without the optional flox package.
    by_day = readings.resample("1h").mean().resample("1D")
    daily = pd.DataFrame({"value": by_day.mean(), "hours": by_day.count()})
    daily = daily[daily["hours"] >= min_hours]
    daily.index = pd.DatetimeIndex(daily.index, name="date")
    return daily
