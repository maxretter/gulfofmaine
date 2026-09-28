import datetime as dt

import pytest
from sqlalchemy import select

from heatwaves.models import Event
from heatwaves.sync import update_heatwaves
from tests.conftest import add_series, seasonal_temperatures

TODAY = dt.datetime.now(dt.UTC).date()


@pytest.fixture
def heatwave_now(session):
    """A series whose last eight days run 2.5 degrees above normal, with a gap last month."""
    temperatures = seasonal_temperatures("2003-01-01", TODAY)
    temperatures.iloc[-8:] += 2.5
    gap = TODAY - dt.timedelta(days=30)
    temperatures = temperatures.drop(temperatures[str(gap - dt.timedelta(days=4)) : str(gap)].index)
    series = add_series(session, temperatures)
    update_heatwaves(session, series)
    series.synced_at = dt.datetime.now(dt.UTC)
    session.commit()
    return series


def test_buoys_report_the_heatwave_in_progress(client, session, heatwave_now):
    response = client.get("/api/buoys")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=300"
    [buoy] = response.json()
    [condition] = buoy["series"]
    ongoing = session.scalars(select(Event).where(Event.end_date == TODAY)).one()
    assert condition["state"] == "heatwave"
    assert condition["date"] == TODAY.isoformat()
    assert condition["category"] == ongoing.category
    assert condition["event_start"] == ongoing.start_date.isoformat()
    assert condition["anomaly"] > 1.5


def test_daily_series_keeps_gaps_as_nulls(client, heatwave_now):
    start = TODAY - dt.timedelta(days=40)
    response = client.get(f"/api/buoys/a01/1/daily?start={start}&end={TODAY}")

    assert response.status_code == 200
    days = response.json()
    assert len(days) == 41
    assert sum(day["temperature"] is None for day in days) == 5
    assert all(day["threshold"] > day["climatology"] for day in days)


def test_daily_series_rejects_an_unknown_depth(client, heatwave_now):
    assert client.get("/api/buoys/A01/300/daily").status_code == 404


def test_health_check_fails_when_sync_stops(client, session, heatwave_now):
    assert client.get("/healthz").status_code == 200

    heatwave_now.synced_at = dt.datetime.now(dt.UTC) - dt.timedelta(hours=6)
    session.commit()

    response = client.get("/healthz")
    assert response.status_code == 503
    assert response.json()["status"] == "stale"


def test_pages_render(client, heatwave_now):
    for path in ("/", "/?depth=1", "/buoys/A01", "/about"):
        response = client.get(path)
        assert response.status_code == 200, path
    assert "heatwave · day" in client.get("/").text
