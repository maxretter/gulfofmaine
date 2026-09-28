import numpy as np
import pandas as pd
import pytest
import xarray as xr

from heatwaves import qc


def raw_rows(times, values, umaine_flags, qartod_flags, variable="temperature") -> xr.Dataset:
    """Rows shaped like an ERDDAP tabledap NetCDF response."""
    umaine, qartod = qc.flags(variable)
    return xr.Dataset(
        {
            variable: ("row", np.asarray(values, dtype="float32")),
            umaine: ("row", np.asarray(umaine_flags, dtype="float32")),
            qartod: ("row", np.asarray(qartod_flags, dtype="float32")),
        },
        coords={"time": ("row", pd.to_datetime(times))},
    )


def test_daily_means_drop_flagged_readings_and_thin_days():
    # Day one: 48 half-hourly readings of 10 degrees, plus a bad reading from
    # each flag at the same times as good ones. Day two: 10 hours of data.
    day_one = pd.date_range("2026-01-01", periods=48, freq="30min")
    day_two = pd.date_range("2026-01-02", periods=10, freq="1h")
    times = [*day_one, day_one[0], day_one[1], *day_two]
    temperatures = [10.0] * 48 + [99.0, -99.0] + [12.0] * 10
    umaine = [0] * 48 + [2, 0] + [0] * 10
    qartod = [1] * 48 + [1, 4] + [1] * 10

    daily = qc.daily_means(raw_rows(times, temperatures, umaine, qartod))

    assert list(daily.index) == [pd.Timestamp("2026-01-01")]
    assert daily.loc["2026-01-01", "value"] == pytest.approx(10.0)
    assert daily.loc["2026-01-01", "hours"] == 24


def test_daily_means_weight_hours_equally_whatever_the_sampling_rate():
    # Twelve hours at 5 degrees sampled every 10 minutes, twelve at 15 sampled
    # hourly: the mean of hourly bins is 10, not the 7.9 of the raw readings.
    fast = pd.date_range("2026-01-01T00:00", "2026-01-01T11:50", freq="10min")
    slow = pd.date_range("2026-01-01T12:00", "2026-01-01T23:00", freq="1h")
    times = [*fast, *slow]
    temperatures = [5.0] * len(fast) + [15.0] * len(slow)

    daily = qc.daily_means(raw_rows(times, temperatures, [0] * len(times), [1] * len(times)))

    assert daily["value"].iloc[0] == pytest.approx(10.0)


def test_daily_means_read_each_variable_by_its_own_flags():
    times = pd.date_range("2026-01-01", periods=24, freq="1h")
    salinity = raw_rows(times, [31.0] * 23 + [0.0], [0] * 24, [1] * 23 + [4], variable="salinity")

    daily = qc.daily_means(salinity, "salinity", min_hours=23)

    assert qc.columns(["salinity"]) == ["time", "salinity", "salinity_qc", "salinity_qc_agg"]
    assert daily.loc["2026-01-01", "value"] == pytest.approx(31.0)
    assert daily.loc["2026-01-01", "hours"] == 23
