"""The sync against recorded ERDDAP responses (see tests/conftest.py)."""

import datetime as dt

import httpx
import pandas as pd
import pytest
from sqlalchemy import select

from heatwaves import sync
from heatwaves.models import Buoy, DailyMean, Event, Series
from heatwaves.sources import TabledapSource
from heatwaves.stations import SERIES
from heatwaves.sync import ensure_catalog, sync_all, sync_series
from tests.conftest import (
    A01_SYNC,
    A01_SYNC_WITH_SALINITY,
    CATALOG,
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


def test_sync_stops_after_one_request_when_the_newest_stamp_was_already_read(session, series):
    series.modified_through = dt.datetime(2026, 9, 28, 16, 32, 11, tzinfo=dt.UTC)  # as in newest.json
    requests: list[str] = []

    assert not sync_series(session, buoy_sources(recorded_erddap(A01_SYNC, requests)), series)

    assert len(requests) == 1


def test_sync_clears_days_whose_rows_are_gone(session, series):
    # ERDDAP stamped changes to these days, but no rows remain in them.
    requests: list[str] = []
    gone = [*A01_SYNC[:2], ("/A01_ocean_001m.nc?", NO_MATCH)]

    assert sync_series(session, buoy_sources(recorded_erddap(gone, requests)), series)

    days = session.scalars(select(DailyMean.date).where(DailyMean.date >= dt.date(2026, 9, 20))).all()
    assert days == [dt.date(2026, 9, day) for day in (20, 21, 22, 23)]
    assert series.modified_through == dt.datetime(2026, 9, 28, 16, 32, 11, tzinfo=dt.UTC)


def test_catalog_adds_each_series_once_with_its_buoy_position(session):
    requests: list[str] = []
    erddap = recorded_erddap(CATALOG, requests)

    ensure_catalog(session, erddap)
    ensure_catalog(session, erddap)

    # Temperature and salinity at 25 buoy depths, and 6 satellite cells.
    assert len(session.scalars(select(Series)).all()) == len(SERIES) == 2 * 25 + 6
    a01 = session.get_one(Buoy, "A01")
    assert (a01.name, a01.latitude, a01.longitude) == ("Massachusetts Bay", 42.5183, -70.5681)
    # Positions come from each buoy's shallowest dataset.
    assert 'datasetID=~"^(A01_ocean_001m|B01_ocean_001m|E01_ocean_001m|' in requests[0]
    assert session.get_one(Buoy, "N01").latitude == 42.3207


def test_a_failing_dataset_doesnt_stop_the_others(session_factory):
    # A01's datasets have nothing new; every other buoy dataset answers with
    # an error, and there's no source for the satellite dataset at all.
    erddap = recorded_erddap([*CATALOG, ("/A01_", NO_MATCH)], [])

    assert sync_all(session_factory, erddap, buoy_sources(erddap)) == 22 + 1

    with session_factory() as session:
        synced = session.scalars(select(Series.dataset_id).where(Series.synced_at.is_not(None))).all()
    # Temperature and salinity from each of A01's datasets.
    assert sorted(synced) == sorted(["A01_ocean_001m", "A01_ocean_020m", "A01_ocean_050m"] * 2)


@pytest.mark.parametrize(("failures", "status"), [(0, 0), (2, 1)])
def test_sync_job_exit_status_reports_failures(monkeypatch, session_factory, failures, status):
    monkeypatch.setattr("heatwaves.db.SessionLocal", session_factory)
    monkeypatch.setattr(sync, "sync_all", lambda *args: failures)

    assert sync.main([]) == status


class Stop(Exception):
    """Ends the sync job's loop in a test."""


def test_sync_job_retries_after_erddap_is_unreachable(monkeypatch, session_factory):
    rounds = 0

    def sync_all(*args):
        nonlocal rounds
        rounds += 1
        if rounds == 1:
            raise httpx.ConnectError("ERDDAP is down")
        return 0

    def sleep(seconds):
        assert seconds == 60
        if rounds == 2:
            raise Stop

    monkeypatch.setattr("heatwaves.db.SessionLocal", session_factory)
    monkeypatch.setattr(sync, "sync_all", sync_all)
    monkeypatch.setattr(sync.time, "sleep", sleep)

    with pytest.raises(Stop):
        sync.main(["--every", "60"])
    assert rounds == 2
    # Run once, the job fails instead.
    rounds = 0
    with pytest.raises(httpx.ConnectError):
        sync.main([])


def test_recompute_rebuilds_heatwaves_from_stored_data(monkeypatch, session_factory, session):
    temperatures = seasonal_temperatures("2003-01-01", "2026-09-27")
    temperatures.iloc[-8:] += 2.5
    series = add_series(session, temperatures)
    monkeypatch.setattr("heatwaves.db.SessionLocal", session_factory)

    assert sync.main(["--recompute"]) == 0

    session.refresh(series)
    assert series.latest_date == dt.date(2026, 9, 27)
    assert session.scalars(select(Event).where(Event.end_date == series.latest_date)).one().duration >= 8
