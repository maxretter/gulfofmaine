"""The sync against recorded ERDDAP responses (see tests/conftest.py)."""

import datetime as dt

import pandas as pd
import pytest
from sqlalchemy import select

from heatwaves.models import DailyMean, Event
from heatwaves.sources import TabledapSource
from heatwaves.sync import sync_series
from tests.conftest import (
    A01_SYNC,
    A01_SYNC_WITH_SALINITY,
    NO_MATCH,
    add_series,
    recorded_erddap,
    seasonal_temperatures,
)


def buoy_sources(erddap):
    return {"buoy": TabledapSource(erddap)}


@pytest.fixture
def series(session):
    # Twenty-odd years of synthetic history up to the recorded days, plus
    # stale placeholder values for the days ERDDAP is about to replace.
    history = seasonal_temperatures("2003-01-01", "2026-09-27")
    history["2026-09-24":] = -1.0
    series = add_series(session, history)
    series.modified_through = dt.datetime(2026, 9, 26, 12, tzinfo=dt.UTC)
    session.commit()
    return series


def test_sync_rereads_only_the_days_that_changed(session, series):
    requests: list[str] = []

    assert sync_series(session, buoy_sources(recorded_erddap(A01_SYNC, requests)), series)

    newest, span, data = requests
    # Two days of overlap behind the stored high-water mark...
    assert "time_modified>2026-09-24T12:00:00Z" in newest
    assert "time_modified<=2026-09-28T16:32:11Z" in span
    # ...then whole days, covering every row that changed.
    assert data.startswith("https://data.neracoos.org/erddap/tabledap/A01_ocean_001m.nc?time,temperature,")
    assert "time>=2026-09-24T00:00:00Z&time<2026-09-29T00:00:00Z" in data

    daily = dict(session.execute(select(DailyMean.date, DailyMean.value)).all())
    replaced = [daily[dt.date(2026, 9, day)] for day in (24, 25, 26, 27)]
    assert all(14 < value < 17 for value in replaced)  # real September surface temperatures
    assert dt.date(2026, 9, 28) not in daily  # still incomplete: under 18 hours
    assert daily[dt.date(2026, 9, 23)] != -1.0  # untouched history

    assert series.modified_through == dt.datetime(2026, 9, 28, 16, 32, 11, tzinfo=dt.UTC)
    assert series.latest_date == dt.date(2026, 9, 27)
    assert series.latest_threshold is not None


def test_sync_stops_after_one_request_when_nothing_changed(session, series):
    requests: list[str] = []
    events_before = session.scalars(select(Event)).all()

    assert not sync_series(session, buoy_sources(recorded_erddap([("", NO_MATCH)], requests)), series)

    assert len(requests) == 1
    assert series.synced_at is not None
    assert series.modified_through == dt.datetime(2026, 9, 26, 12, tzinfo=dt.UTC)
    assert session.scalars(select(Event)).all() == events_before


def test_sync_fetches_every_variable_of_a_dataset_at_once(session, series):
    salinity = add_series(
        session, pd.Series(31.0, index=pd.date_range("2026-09-01", "2026-09-27")), variable="salinity"
    )
    salinity.modified_through = series.modified_through
    session.commit()
    requests: list[str] = []

    assert sync_series(session, buoy_sources(recorded_erddap(A01_SYNC_WITH_SALINITY, requests)), salinity)

    _, _, data = requests
    assert "?time,temperature,temperature_qc,temperature_qc_agg,salinity,salinity_qc,salinity_qc_agg&" in data
    for each, low, high in ((series, 14, 17), (salinity, 31, 32)):
        values = session.scalars(
            select(DailyMean.value).where(
                DailyMean.series_id == each.id, DailyMean.date >= dt.date(2026, 9, 24)
            )
        ).all()
        assert len(values) == 4
        assert all(low < value < high for value in values)
        assert each.modified_through == dt.datetime(2026, 9, 28, 16, 32, 11, tzinfo=dt.UTC)
