"""scripts/satellite_correlation.py, on synthetic records."""

import numpy as np
import pandas as pd
import pytest

from heatwaves.stations import SourceName, Variable
from heatwaves.sync import update_heatwaves
from scripts import satellite_correlation
from tests.conftest import add_series, seasonal_temperatures

START, END = "2003-01-01", "2022-12-31"


def test_temperatures_correlate_through_the_seasons_and_anomalies_only_when_shared(session):
    days = pd.date_range(START, END)
    # Anomalies seen by A01 and its satellite cell alike; B01 and its cell each have only noise of their own.
    noise = pd.Series(np.random.default_rng(0).normal(0, 1, len(days)), index=days)
    shared = noise.rolling(10, min_periods=1).mean()
    a01 = seasonal_temperatures(START, END, noise=0.1, seed=1) + shared
    a01_satellite = seasonal_temperatures(START, END, noise=0.1, seed=2) + shared
    a01 = a01.drop(a01["2010-03-01":"2010-03-31"].index)
    a01_satellite = a01_satellite.drop(a01_satellite["2015-06-01":"2015-06-30"].index)
    for values, buoy, depth, source in (
        (a01, "A01", 1, SourceName.BUOY),
        (a01_satellite, "A01", 0, SourceName.SATELLITE),
        (seasonal_temperatures(START, END, seed=3), "B01", 1, SourceName.BUOY),
        (seasonal_temperatures(START, END, seed=4), "B01", 0, SourceName.SATELLITE),
        # Not compared: no satellite series, and a depth other than 1 m.
        (seasonal_temperatures(START, END, seed=5), "N01", 1, SourceName.BUOY),
        (seasonal_temperatures(START, END, seed=6), "B01", 50, SourceName.BUOY),
    ):
        update_heatwaves(session, add_series(session, values, buoy, depth, Variable.TEMPERATURE, source))

    pairs = satellite_correlation.paired_days(session)
    assert list(pairs) == ["A01", "B01"]
    # Only the days both have data.
    assert len(pairs["A01"]) == len(days) - 31 - 30
    assert pairs["A01"].notna().all().all()

    table = satellite_correlation.correlations(pairs)
    assert list(table.index) == ["A01", "B01", "all"]
    assert list(table["days"]) == [len(days) - 61, len(days), 2 * len(days) - 61]
    assert (table["temperature"] > 0.95).all()
    anomaly = table["anomaly"].to_dict()
    assert anomaly["A01"] > 0.8
    assert anomaly["B01"] == pytest.approx(0, abs=0.05)
    assert anomaly["B01"] < anomaly["all"] < anomaly["A01"]


def test_nothing_to_compare(session):
    assert satellite_correlation.correlations(satellite_correlation.paired_days(session)).empty
