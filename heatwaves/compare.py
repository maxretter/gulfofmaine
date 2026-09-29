"""Comparing the heatwave records of two series, such as a buoy depth and the satellite above it.

Plain functions over pandas objects, with no database or network access.
"""

import pandas as pd

OUTCOMES = ["both", "satellite_only", "buoy_only", "neither"]


def in_heatwave(observed: pd.DatetimeIndex, heatwave_days: pd.Series) -> pd.Series:
    """For each observed day, whether it was a heatwave day (as from queries.heatwave_days)."""
    return pd.Series(observed.isin(heatwave_days.index), index=observed)


def agreement(buoy: pd.Series, satellite: pd.Series) -> pd.DataFrame:
    """Days both flagged a heatwave, only one did, or neither, per year.

    Each argument is True on heatwave days and False on other days with
    data, as from `in_heatwave`. Only days both have data for are counted.
    Returns a frame indexed by year with a column per outcome in OUTCOMES.
    """
    days = buoy.index.intersection(satellite.index)
    at_buoy = buoy.reindex(days).to_numpy(dtype=bool)
    from_space = satellite.reindex(days).to_numpy(dtype=bool)
    outcomes = pd.DataFrame(
        {
            "both": at_buoy & from_space,
            "satellite_only": from_space & ~at_buoy,
            "buoy_only": at_buoy & ~from_space,
            "neither": ~at_buoy & ~from_space,
        },
        index=days,
    )
    return outcomes.groupby(pd.DatetimeIndex(days).year.rename("year")).sum()[OUTCOMES]
