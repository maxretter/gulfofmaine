"""Quality control and daily averaging of raw buoy readings.

Every variable in the UMaine datasets on NERACOOS ERDDAP carries two flags:
UMaine's own ({variable}_qc) and the QARTOD aggregate ({variable}_qc_agg).
Readings that UMaine's flag doesn't mark good, or that the QARTOD flag marks
suspect or fail, are dropped before averaging, so the same functions serve
temperature, salinity or any other variable.
"""

from collections.abc import Iterable

import pandas as pd
import xarray as xr

# Hourly bins a day needs for its mean to count. The current UTC day has
# them once its 18th hour (17:00-18:00) has a reading, so it's stored from
# about 18:00 UTC on the hours so far, and re-read as the rest arrive.
MIN_HOURS = 18

# UMaine's flag uses 0 for quality_good. The QARTOD aggregate flag uses
# 3 for suspect and 4 for fail. Asked for the distinct combinations of the
# flags in every dataset (2026-09-30), ERDDAP had no reading marked suspect:
# the aggregate is 1 (pass) wherever UMaine's flag is 0, and 4 (fail) or 2
# (not evaluated) wherever it isn't, so for now UMaine's flag alone decides.
# On the readings it marks good, the individual tests ({variable}_qc_tests)
# that ran are gap, syntax, location and gross range; the rest weren't.
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
    day's value doesn't depend on the sampling rate, which differs: in
    samples from 2001 to 2026, every 30 minutes at 1 m and hourly at 20 m
    and below. Days with fewer than `min_hours` hourly bins are left out.

    Returns a frame indexed by UTC day, with `value` and `hours` columns.
    """
    # Resampled in pandas: for 25 years of half-hourly readings it took 15-40 ms,
    # and xarray's resample, without the optional flox package, 25-28 s.
    by_day = readings.resample("1h").mean().resample("1D")
    daily = pd.DataFrame({"value": by_day.mean(), "hours": by_day.count()})
    daily = daily[daily["hours"] >= min_hours]
    daily.index = pd.DatetimeIndex(daily.index, name="date")
    return daily
