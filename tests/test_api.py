import datetime as dt
import os

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from heatwaves import db
from heatwaves.main import app, revalidate_api_responses
from heatwaves.models import Buoy, Event, Series, UTCDateTime
from heatwaves.sync import update_heatwaves
from tests.conftest import NOW, TODAY, add_series, api_client, seasonal_temperatures

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "sqlite://")


@pytest.fixture
def heatwave_now(session, stopped_clock):
    """A series whose last eight days, to today, run 2.5 degrees above normal, with a gap last month."""
    temperatures = seasonal_temperatures("2003-01-01", TODAY)
    temperatures.iloc[-8:] += 2.5
    gap = TODAY - dt.timedelta(days=30)
    temperatures = temperatures.drop(temperatures[str(gap - dt.timedelta(days=4)) : str(gap)].index)
    series = add_series(session, temperatures)
    update_heatwaves(session, series)
    series.synced_at = NOW
    session.commit()
    return series


def test_buoys_report_the_heatwave_in_progress(client, session, heatwave_now):
    response = client.get("/api/buoys")

    assert response.status_code == 200
    [buoy] = response.json()
    [condition] = buoy["series"]
    ongoing = session.scalars(select(Event).where(Event.end_date == TODAY)).one()
    assert condition["state"] == "heatwave"
    assert condition["date"] == TODAY.isoformat()
    assert condition["category"] == ongoing.category
    assert condition["event_start"] == ongoing.start_date.isoformat()
    assert condition["anomaly"] > 1.5
    assert condition["first_date"] == "2003-01-01"
    assert condition["synced_at"] is not None


def test_buoys_report_a_paused_heatwave_as_they_do_one_in_progress(client, session, stopped_clock):
    temperatures = seasonal_temperatures("2003-01-01", TODAY)
    temperatures.iloc[-9:-1] += 2.5
    temperatures.iloc[-1] -= 2.0  # today, a dip below the threshold
    update_heatwaves(session, add_series(session, temperatures))
    session.commit()

    [buoy] = client.get("/api/buoys").json()
    [condition] = buoy["series"]
    paused = session.scalars(select(Event)).one()
    assert paused.end_date == TODAY - dt.timedelta(days=1)
    assert (condition["state"], condition["days_above"]) == ("paused", 0)
    assert condition["category"] == paused.category
    assert condition["category_name"] == paused.category_name
    assert condition["event_start"] == paused.start_date.isoformat()


def test_buoys_give_each_series_its_own_first_day(client, session, stopped_clock):
    for depth, first, source in (
        (1, "2003-01-01", "buoy"),
        (20, "2005-06-01", "buoy"),
        (0, "2001-01-01", "satellite"),
    ):
        add_series(session, seasonal_temperatures(first, TODAY), "A01", depth, source=source)
    # A series the sync has created but found no data for yet.
    session.add(
        Series(buoy_id="A01", depth=50, variable="temperature", source="buoy", dataset_id="A01_ocean_050m")
    )
    session.commit()

    [buoy] = client.get("/api/buoys").json()

    assert [(each["depth"], each["first_date"]) for each in buoy["series"]] == [
        (1, "2003-01-01"),
        (20, "2005-06-01"),
        (50, None),
    ]
    assert buoy["satellite"]["first_date"] == "2001-01-01"


@pytest.mark.parametrize(
    "path", ["/api/buoys", "/api/events", "/api/buoys/A01/1/daily?start=2003-01-01", "/api/data"]
)
def test_responses_are_revalidated_by_etag(client, path, heatwave_now):
    # The live feed can change any of them at any moment, so no cache may reuse a copy unchecked.
    first = client.get(path)
    assert first.headers["cache-control"] == "no-cache"
    [etag] = first.headers.get_list("etag")

    unchanged = client.get(path, headers={"If-None-Match": etag})

    assert unchanged.status_code == 304
    assert unchanged.content == b""
    # The ETag is of the JSON, not of the gzipped bytes, which differ every time.
    assert client.get(path, headers={"Accept-Encoding": "identity"}).headers["etag"] == first.headers["etag"]


def test_a_changed_response_gets_a_new_etag(client, session, heatwave_now):
    first = client.get("/api/buoys")

    heatwave_now.latest_reading = 18.2
    session.commit()
    changed = client.get("/api/buoys", headers={"If-None-Match": first.headers["etag"]})

    assert changed.status_code == 200
    assert changed.headers["etag"] != first.headers["etag"]
    assert changed.json()[0]["series"][0]["reading"] == 18.2


def test_the_etag_replaces_one_the_route_set():
    tagged = FastAPI()
    tagged.middleware("http")(revalidate_api_responses)

    @tagged.get("/api/tagged")
    def route() -> JSONResponse:
        return JSONResponse([], headers={"ETag": '"route"', "Cache-Control": "max-age=60"})

    response = TestClient(tagged).get("/api/tagged")

    [etag] = response.headers.get_list("etag")
    assert etag != '"route"'
    assert response.headers.get_list("cache-control") == ["no-cache"]


def test_times_come_back_in_utc_whatever_the_database_zone():
    eastern = dt.datetime(2026, 9, 28, 22, tzinfo=dt.timezone(dt.timedelta(hours=-4)))

    stored = UTCDateTime().process_result_value(eastern, None)

    assert stored == eastern
    assert stored is not None and stored.tzinfo == dt.UTC


def test_daily_series_keeps_gaps_as_nulls(client, heatwave_now):
    start = TODAY - dt.timedelta(days=40)
    response = client.get(f"/api/buoys/a01/1/daily?start={start}&end={TODAY}")

    assert response.status_code == 200
    days = response.json()
    assert len(days) == 41
    assert sum(day["value"] is None for day in days) == 5
    assert all(day["threshold"] > day["climatology"] for day in days)


def test_daily_series_rejects_an_unknown_depth(client, heatwave_now):
    assert client.get("/api/buoys/A01/300/daily").status_code == 404


def test_health_check_fails_when_sync_stops(client, session, heatwave_now):
    assert client.get("/healthz").status_code == 200

    heatwave_now.synced_at = NOW - dt.timedelta(hours=6)
    session.commit()

    response = client.get("/healthz")
    assert response.status_code == 503
    assert response.json()["status"] == "stale"


def test_requests_read_one_snapshot_on_postgres():
    # Neither engine connects until it's used.
    postgres = create_engine("postgresql+psycopg://heatwaves@localhost/heatwaves")
    sqlite = create_engine("sqlite://")

    assert db.reading(postgres).get_execution_options() == {
        "isolation_level": "REPEATABLE READ",
        "postgresql_readonly": True,
    }
    assert db.reading(sqlite) is sqlite


@pytest.mark.skipif(db.engine.dialect.name != "postgresql", reason="needs Postgres (DATABASE_URL)")
def test_each_request_gets_a_read_only_snapshot():
    for session in db.get_session():  # one, as FastAPI gets it for a request
        assert session.scalar(text("SHOW transaction_isolation")) == "repeatable read"
        assert session.scalar(text("SHOW transaction_read_only")) == "on"


@pytest.mark.skipif(
    not TEST_DATABASE_URL.startswith("postgresql"), reason="needs Postgres (TEST_DATABASE_URL)"
)
def test_the_api_tests_read_as_requests_do(session_factory):
    with api_client(session_factory):
        for session in app.dependency_overrides[db.get_session]():
            assert session.scalar(text("SHOW transaction_isolation")) == "repeatable read"
            assert session.scalar(text("SHOW transaction_read_only")) == "on"


@pytest.mark.skipif(
    not TEST_DATABASE_URL.startswith("postgresql"), reason="needs Postgres (TEST_DATABASE_URL)"
)
def test_a_request_sees_none_of_what_the_sync_commits_meanwhile(session):
    session.add(Buoy(id="A01", name="Before", latitude=None, longitude=None))
    session.commit()
    engine = create_engine(TEST_DATABASE_URL, pool_size=1, max_overflow=0)  # one connection, reused
    try:
        with Session(db.reading(engine)) as request:
            assert request.scalar(select(Buoy.name)) == "Before"
            session.get_one(Buoy, "A01").name = "After"
            session.commit()
            assert request.scalar(select(Buoy.name)) == "Before"
            with pytest.raises(DBAPIError, match="read-only transaction"):
                request.execute(update(Buoy).values(name="Written by a request"))

        # The connection went back to the pool as it came, for the sync's sessions.
        with Session(engine) as sync:
            assert sync.scalar(select(Buoy.name)) == "After"
            assert sync.scalar(text("SHOW transaction_isolation")) == "read committed"
            assert sync.scalar(text("SHOW transaction_read_only")) == "off"
    finally:
        engine.dispose()
