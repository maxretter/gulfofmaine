import datetime as dt

import numpy as np
import pandas as pd
import pytest
import xarray as xr

from heatwaves import hobday
from tests.conftest import seasonal_temperatures


def raw_rows(times, temperatures, umaine_flags, qartod_flags) -> xr.Dataset:
    """Rows shaped like an ERDDAP tabledap NetCDF response."""
    return xr.Dataset(
        {
            "temperature": ("row", np.asarray(temperatures, dtype="float32")),
            "temperature_qc": ("row", np.asarray(umaine_flags, dtype="float32")),
            "temperature_qc_agg": ("row", np.asarray(qartod_flags, dtype="float32")),
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

    daily = hobday.daily_means(raw_rows(times, temperatures, umaine, qartod))

    assert list(daily.index) == [pd.Timestamp("2026-01-01")]
    assert daily.loc["2026-01-01", "temperature"] == pytest.approx(10.0)
    assert daily.loc["2026-01-01", "hours"] == 24


def test_daily_means_weight_hours_equally_whatever_the_sampling_rate():
    # Twelve hours at 5 degrees sampled every 10 minutes, twelve at 15 sampled
    # hourly: the mean of hourly bins is 10, not the 7.9 of the raw readings.
    fast = pd.date_range("2026-01-01T00:00", "2026-01-01T11:50", freq="10min")
    slow = pd.date_range("2026-01-01T12:00", "2026-01-01T23:00", freq="1h")
    times = [*fast, *slow]
    temperatures = [5.0] * len(fast) + [15.0] * len(slow)

    daily = hobday.daily_means(raw_rows(times, temperatures, [0] * len(times), [1] * len(times)))

    assert daily["temperature"].iloc[0] == pytest.approx(10.0)


def test_day_of_year_gives_feb_29_its_own_slot():
    days = pd.DatetimeIndex(["2023-02-28", "2023-03-01", "2024-02-29", "2024-03-01", "2023-12-31"])
    assert list(hobday.day_of_year(days)) == [59, 61, 60, 61, 366]


def test_fill_short_gaps_leaves_long_gaps_entirely_empty():
    values = [1.0, np.nan, np.nan, 4.0, np.nan, np.nan, np.nan, 8.0]
    series = pd.Series(values, index=pd.date_range("2026-01-01", periods=len(values)))

    filled = hobday.fill_short_gaps(series, max_length=2)

    assert filled.iloc[:4].tolist() == [1.0, 2.0, 3.0, 4.0]
    assert filled.iloc[4:7].isna().all()  # pandas' interpolate(limit=2) would fill two of these


def test_climatology_recovers_a_known_seasonal_cycle():
    noise = 1.0
    temperatures = seasonal_temperatures("2003-01-01", "2022-12-31", noise=noise)

    stats = hobday.climatology(temperatures, (2003, 2022))

    days = pd.date_range("2021-01-01", "2021-12-31")
    expected = 10 + 6 * np.sin(2 * np.pi * (days.dayofyear.to_numpy() - 120) / 365.25)
    by_day = stats.sel(day_of_year=hobday.day_of_year(days))
    # Smoothing over 31 days flattens the peaks of a 6-degree cycle by ~0.1.
    np.testing.assert_allclose(by_day["mean"], expected, atol=0.2)
    # For Gaussian noise the 90th percentile sits 1.28 standard deviations up.
    # (The seasonal slope across each 11-day window widens it slightly.)
    np.testing.assert_allclose(by_day["threshold"] - by_day["mean"], 1.2816 * noise, atol=0.15)
    # The running mean wraps: no seam between Dec 31 and Jan 1.
    assert abs(float(stats["mean"].sel(day_of_year=366) - stats["mean"].sel(day_of_year=1))) < 0.1


def test_climatology_refuses_a_sparse_baseline():
    temperatures = seasonal_temperatures("2003-01-01", "2008-12-31")
    with pytest.raises(hobday.InsufficientData):
        hobday.climatology(temperatures, (2003, 2022))


def flat_frame(temperatures: list[float]) -> pd.DataFrame:
    """An `align`-style frame with a normal of 10 and a threshold of 11."""
    days = pd.date_range("2026-06-01", periods=len(temperatures))
    return pd.DataFrame({"temperature": temperatures, "climatology": 10.0, "threshold": 11.0}, index=days)


def test_events_need_five_days_and_join_across_gaps_of_two():
    normal, warm = 10.0, 11.5
    temperatures = (
        [warm] * 4
        + [normal] * 3  # four days: too short
        + [warm] * 5
        + [normal] * 2
        + [warm] * 5
        + [normal] * 3  # joined across a two-day gap
        + [warm] * 5
        + [normal] * 3
        + [warm] * 5  # a three-day gap: two events
    )

    events = hobday.detect_events(flat_frame(temperatures))

    start = dt.date(2026, 6, 1)
    spans = [((e.start - start).days, (e.end - start).days) for e in events]
    assert spans == [(7, 18), (22, 26), (30, 34)]
    assert events[0].duration == 12


def test_event_category_counts_multiples_of_the_threshold_distance():
    # Threshold is 1 degree above normal, so peaks 2.5 and 5 degrees above
    # normal are Strong (2) and, capped, Extreme (4).
    strong = hobday.detect_events(flat_frame([11.5, 12.5, 11.5, 11.5, 11.5]))
    extreme = hobday.detect_events(flat_frame([11.5, 15.0, 11.5, 11.5, 11.5]))

    assert (strong[0].category, strong[0].max_intensity, strong[0].peak) == (2, 2.5, dt.date(2026, 6, 2))
    assert extreme[0].category == 4


def test_event_category_comes_from_the_largest_multiple_not_the_warmest_day():
    # Day 2 is warmest relative to normal (3.9) but only 1.95 multiples of its
    # wide threshold; day 5 is 2.1 multiples. The reference implementation
    # agrees: Strong, with the peak intensity still on day 2.
    frame = flat_frame([11.5, 13.9, 11.5, 11.5, 12.1])
    frame["threshold"] = [11.0, 12.0, 11.0, 11.0, 11.0]

    [event] = hobday.detect_events(frame)

    assert (event.category, event.peak, event.max_intensity) == (2, dt.date(2026, 6, 2), pytest.approx(3.9))


def test_latest_status_counts_consecutive_days_above():
    status = hobday.latest_status(flat_frame([11.5, 10.0, 11.5, 11.5, 11.5]))
    assert (status.date, status.days_above, status.temperature) == (dt.date(2026, 6, 5), 3, 11.5)
