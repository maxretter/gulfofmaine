"""The live feed: what a sync announces, and how the API relays it to browsers (heatwaves.live)."""

import asyncio
import contextlib
import dataclasses
import datetime as dt
import json
import os
import time
from collections.abc import AsyncIterator, Callable

import pandas as pd
import psycopg
import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from heatwaves import live, main
from heatwaves.config import Settings
from heatwaves.live import Hub, ReadingMessage, StatusMessage
from heatwaves.models import Event, Series
from heatwaves.sources import Download, Reading, TabledapSource
from heatwaves.state import SeriesState, state_of
from heatwaves.sync import store, sync_series, update_heatwaves
from tests.conftest import A01_SYNC, add_series, recorded_erddap, seasonal_temperatures

# The sync judges each series' state on the wall clock's day (sync.update_heatwaves), so these
# follow it. A series whose newest day is TODAY stays reporting for state.OFFLINE_AFTER after.
TODAY = dt.datetime.now(dt.UTC).date()
NOW = dt.datetime.now(dt.UTC).replace(minute=0, second=0, microsecond=0)

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "sqlite://")
postgres_only = pytest.mark.skipif(
    live.libpq_url(TEST_DATABASE_URL) is None, reason="NOTIFY and LISTEN need Postgres (TEST_DATABASE_URL)"
)


@pytest.fixture
def libpq_url() -> str:
    """The test database's URL for psycopg; with postgres_only."""
    url = live.libpq_url(TEST_DATABASE_URL)
    assert url is not None
    return url


def on_app_loop(client: TestClient, function: Callable[..., object], *args: object) -> None:
    """Run a function on the event loop the app and its WebSockets run on."""
    assert client.portal is not None, "use the TestClient as a context manager"
    client.portal.call(function, *args)


def download(series: Series, values: pd.Series, reading: Reading | None = None) -> Download:
    """What a source would return for `series`: these daily values, and optionally a newest reading."""
    days = pd.DatetimeIndex(values.index, name="date")
    return Download(
        first_day=days[0].date(),
        last_day=days[-1].date(),
        daily={series.id: pd.DataFrame({"value": values.to_numpy(), "hours": 24}, index=days)},
        modified_through=NOW,
        latest={series.id: reading} if reading else {},
    )


@pytest.fixture
def normal_until_yesterday(session):
    """A series up to yesterday, ending well below its heatwave threshold."""
    temperatures = seasonal_temperatures("2003-01-01", TODAY - dt.timedelta(days=1))
    temperatures.iloc[-12:] -= 2.0
    series = add_series(session, temperatures)
    update_heatwaves(session, series)
    session.commit()
    return series


def test_a_sync_announces_a_new_reading_and_a_heatwave_starting(session, normal_until_yesterday):
    series = normal_until_yesterday
    warm = seasonal_temperatures(str(TODAY - dt.timedelta(days=7)), TODAY) + 2.5

    messages = store(session, [series], download(series, warm, Reading(NOW, 17.3)))

    reading, status = messages
    assert reading == ReadingMessage(buoy="A01", depth=1, time=NOW, temperature=17.3)
    assert isinstance(status, StatusMessage)
    assert (status.previous_state, status.state) == ("normal", "heatwave")
    assert status.date == TODAY
    assert status.days_above == 8
    assert status.category is not None
    assert (series.latest_reading_at, series.latest_reading) == (NOW, 17.3)


def test_a_sync_announces_a_heatwave_in_progress_that_grows_or_changes(session, normal_until_yesterday):
    series = normal_until_yesterday
    warm = seasonal_temperatures(str(TODAY - dt.timedelta(days=7)), TODAY) + 2.5
    store(session, [series], download(series, warm[:-1]))

    # A day longer, in the same category: pages showing it would otherwise say it ended yesterday.
    [longer] = store(session, [series], download(series, warm[-1:]))

    assert isinstance(longer, StatusMessage)
    assert (longer.previous_state, longer.state) == ("heatwave", "heatwave")
    assert longer.previous_category == longer.category is not None
    assert (longer.date, longer.days_above) == (TODAY, 8)

    # Today's mean again, from more hours: the heatwave's intensity changes.
    [warmer] = store(session, [series], download(series, warm[-1:] + 0.5))

    assert isinstance(warmer, StatusMessage)
    assert (warmer.previous_state, warmer.state, warmer.date) == ("heatwave", "heatwave", TODAY)
    assert warmer.previous_category == warmer.category


def test_a_sync_that_changes_neither_reading_nor_heatwave_announces_nothing(session, normal_until_yesterday):
    series = normal_until_yesterday
    warm = seasonal_temperatures(str(TODAY - dt.timedelta(days=7)), TODAY) + 2.5
    store(session, [series], download(series, warm, Reading(NOW, 17.3)))

    # The days before today again, as when their rows are stamped anew, with an older reading from them.
    yesterday = NOW - dt.timedelta(days=1)
    assert store(session, [series], download(series, warm[:-1], Reading(yesterday, 17.0))) == []
    assert series.latest_reading == 17.3

    # A day before the heatwave revised, still well below the threshold.
    cool = seasonal_temperatures(str(TODAY - dt.timedelta(days=8)), TODAY - dt.timedelta(days=8)) - 2.1
    assert store(session, [series], download(series, cool)) == []


def test_only_temperature_goes_on_the_feed(session):
    history = pd.Series(31.0, index=pd.date_range("2003-01-01", TODAY - dt.timedelta(days=1)))
    salinity = add_series(session, history, variable="salinity")
    today = pd.Series([31.2], index=[pd.Timestamp(TODAY)])

    messages = store(session, [salinity], download(salinity, today, Reading(NOW, 31.2)))

    assert messages == []
    assert salinity.latest_reading == 31.2


def test_a_buoy_sync_publishes_its_newest_good_reading(monkeypatch, session):
    series = add_series(session, seasonal_temperatures("2003-01-01", "2026-09-23"))
    series.modified_through = dt.datetime(2026, 9, 26, 12, tzinfo=dt.UTC)
    session.commit()
    published: list[live.Message] = []
    monkeypatch.setattr(live, "publish", lambda session, messages: published.extend(messages))

    sync_series(session, {"buoy": TabledapSource(recorded_erddap(A01_SYNC, []))}, series)

    # The recorded file's last row, at 16:30, has no temperature; the one before is good.
    [reading] = [message for message in published if message.type == "reading"]
    assert reading.time == dt.datetime(2026, 9, 28, 16, tzinfo=dt.UTC)
    assert reading.temperature == 15.11
    assert series.latest_reading_at == reading.time


@pytest.mark.parametrize(
    ("latest", "days_above", "ongoing", "expected"),
    [
        (None, 0, None, ("no_data", None)),
        (TODAY - dt.timedelta(days=4), 9, 2, ("offline", None)),
        (TODAY - dt.timedelta(days=3), 9, 2, ("heatwave", 2)),
        (TODAY, 3, None, ("above_threshold", None)),
        (TODAY, 0, None, ("normal", None)),
    ],
)
def test_state_rules(latest, days_above, ongoing, expected):
    series = Series(latest_date=latest, days_above=days_above, latest_climatology=12.0)
    event = Event(category=ongoing) if ongoing else None

    result = state_of(series, event, TODAY)
    assert (result.state, result.category) == expected


@pytest.mark.parametrize(
    ("latest", "expected"),
    # Offline still, once its newest day is old: that says more than the missing normal.
    [(TODAY, "no_normal"), (TODAY - dt.timedelta(days=4), "offline")],
)
def test_a_series_without_a_normal_is_neither_in_a_heatwave_nor_out_of_one(latest, expected):
    series = Series(latest_date=latest, days_above=0, latest_climatology=None)

    assert state_of(series, None, TODAY) == SeriesState(expected, None)


def test_the_feed_relays_messages_and_pings_when_quiet(monkeypatch):
    monkeypatch.setattr(live, "PING_EVERY", 0.2)
    message = ReadingMessage(buoy="B01", depth=50, time=NOW, temperature=11.4).model_dump_json()

    with TestClient(main.app) as client, client.websocket_connect("/api/live") as browser:
        on_app_loop(client, live.hub.publish, message)

        assert browser.receive_text() == message
        assert browser.receive_json()["type"] == "ping"


def test_the_feed_turns_browsers_away_when_full(monkeypatch):
    monkeypatch.setattr(live.hub, "max_clients", 1)

    with TestClient(main.app) as client, client.websocket_connect("/api/live"):
        with pytest.raises(WebSocketDisconnect) as refused, client.websocket_connect("/api/live"):
            pass
        assert refused.value.code == 1013


@pytest.mark.parametrize(
    "headers",
    [
        {"origin": "http://testserver"},  # a page on the site itself; TestClient sends Host: testserver
        {"origin": "HTTP://TestServer"},
        {},  # not a browser
        {"origin": "https://partner.example"},  # in LIVE_ORIGINS
    ],
)
def test_the_feed_serves_its_own_pages_and_clients_that_arent_browsers(monkeypatch, headers):
    monkeypatch.setattr(
        live,
        "settings",
        dataclasses.replace(live.settings, live_origins=frozenset({"https://partner.example"})),
    )
    monkeypatch.setattr(live, "PING_EVERY", 0.1)

    with TestClient(main.app) as client, client.websocket_connect("/api/live", headers=headers) as browser:
        assert browser.receive_json()["type"] == "ping"


@pytest.mark.parametrize(
    "origin",
    ["https://elsewhere.example", "http://testserver.elsewhere.example", "http://testserver:8000", "null"],
)
def test_the_feed_turns_away_pages_on_other_sites(origin):
    with TestClient(main.app) as client:
        with (
            pytest.raises(WebSocketDisconnect) as refused,
            client.websocket_connect("/api/live", headers={"origin": origin}),
        ):
            pass
        assert refused.value.code == 1008
        assert not live.hub.clients  # it took no place on the feed


def test_live_origins_is_a_comma_separated_list(monkeypatch):
    monkeypatch.setenv("LIVE_ORIGINS", " https://Partner.example/, http://localhost:5173,")

    assert Settings.from_env().live_origins == {"https://partner.example", "http://localhost:5173"}


def test_a_browser_that_falls_behind_is_disconnected_to_refetch():
    hub = Hub(max_clients=2)
    queue = hub.join()
    assert queue is not None

    for n in range(Hub.BACKLOG + 1):
        hub.publish(str(n))

    assert queue.qsize() == 1
    assert queue.get_nowait() is None  # close the connection


def test_the_feed_closes_connections_it_has_to_drop():
    with TestClient(main.app) as client, client.websocket_connect("/api/live") as browser:
        on_app_loop(client, live.hub.disconnect_all)

        with pytest.raises(WebSocketDisconnect) as closed:
            browser.receive_text()
        assert closed.value.code == 1013


class Listening:
    """Stands in for the relay's LISTEN connection to Postgres, delivering what the test puts in `notices`."""

    def __init__(self) -> None:
        self.statements: list[str] = []
        self.notices: asyncio.Queue[str | psycopg.Error] = asyncio.Queue()

    async def __aenter__(self) -> Listening:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        return None

    async def execute(self, statement: str) -> None:
        self.statements.append(statement)

    async def notifies(self) -> AsyncIterator[psycopg.Notify]:
        while True:
            notice = await self.notices.get()
            if isinstance(notice, psycopg.Error):
                raise notice  # the connection is lost
            yield psycopg.Notify(live.CHANNEL, notice, 1)


def test_the_relay_reconnects_and_has_browsers_refetch_what_they_missed(monkeypatch, caplog):
    async def scenario() -> None:
        # Each attempt to connect gets the next of these, once the test has put it here.
        attempts: asyncio.Queue[Listening | psycopg.Error] = asyncio.Queue()

        async def connect(url: str, **options: object) -> Listening:
            attempt = await attempts.get()
            if isinstance(attempt, psycopg.Error):
                raise attempt
            return attempt

        monkeypatch.setattr(psycopg.AsyncConnection, "connect", connect)
        hub = Hub(max_clients=2)
        browser = hub.join()
        assert browser is not None
        relay = asyncio.create_task(live.relay("postgresql://db/heatwaves", hub, retry=0))
        try:
            first = Listening()
            attempts.put_nowait(first)
            first.notices.put_nowait("one")
            # Relayed, and nothing missed yet, so the browser isn't asked to reconnect.
            assert await asyncio.wait_for(browser.get(), 5) == "one"

            # The connection drops, and Postgres, restarting, refuses the next one.
            first.notices.put_nowait(psycopg.OperationalError("server closed the connection unexpectedly"))
            attempts.put_nowait(psycopg.OperationalError("connection refused"))
            second = Listening()
            attempts.put_nowait(second)

            # Once listening again, the relay closes the browser's connection, so it reconnects and refetches.
            assert await asyncio.wait_for(browser.get(), 5) is None
            hub.leave(browser)
            reconnected = hub.join()
            assert reconnected is not None
            second.notices.put_nowait("two")
            assert await asyncio.wait_for(reconnected.get(), 5) == "two"
            assert first.statements == second.statements == [f"LISTEN {live.CHANNEL}"]
        finally:
            relay.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await relay

    asyncio.run(scenario())

    failures = [r for r in caplog.records if r.name == live.__name__ and r.levelname == "WARNING"]
    assert len(failures) == 2  # the lost connection and the refused one


def test_only_postgres_has_a_feed():
    assert live.libpq_url("postgresql+psycopg://heatwaves:secret@db/heatwaves") == (
        "postgresql://heatwaves:secret@db/heatwaves"
    )
    assert live.libpq_url("sqlite:///gom-heatwaves.db") is None


@postgres_only
def test_messages_go_out_only_when_the_sync_commits(session, libpq_url):
    message = ReadingMessage(buoy="A01", depth=1, time=NOW, temperature=15.0)
    with psycopg.connect(libpq_url, autocommit=True) as listener:
        listener.execute(f"LISTEN {live.CHANNEL}")

        live.publish(session, [message])
        assert list(listener.notifies(timeout=0.2, stop_after=1)) == []
        session.commit()

        [notice] = listener.notifies(timeout=5, stop_after=1)
    assert ReadingMessage.model_validate_json(notice.payload) == message


@postgres_only
def test_the_api_relays_every_notice_to_browsers(monkeypatch, libpq_url):
    monkeypatch.setattr(main, "settings", dataclasses.replace(main.settings, database_url=TEST_DATABASE_URL))
    # A missing message then shows up as a ping, not a hang.
    monkeypatch.setattr(live, "PING_EVERY", 5.0)
    engine = create_engine(TEST_DATABASE_URL)
    message = ReadingMessage(buoy="I01", depth=20, time=NOW, temperature=12.5)

    with TestClient(main.app) as client, client.websocket_connect("/api/live") as browser:
        with psycopg.connect(libpq_url, autocommit=True) as db:
            deadline = time.monotonic() + 10
            while not db.execute("SELECT 1 FROM pg_stat_activity WHERE query = 'LISTEN live'").fetchone():
                assert time.monotonic() < deadline, "the API never started listening"
                time.sleep(0.05)
        with sessionmaker(engine)() as session:
            live.publish(session, [message])
            session.commit()

        assert json.loads(browser.receive_text()) == json.loads(message.model_dump_json())
    engine.dispose()


async def listening_backend(db: psycopg.AsyncConnection) -> int:
    """The process ID of the connection Postgres has LISTENing on CHANNEL, once there is one."""
    deadline = time.monotonic() + 10
    while True:
        cursor = await db.execute(
            "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query = %s",
            [f"LISTEN {live.CHANNEL}"],
        )
        row = await cursor.fetchone()
        if row is not None:
            return row[0]
        assert time.monotonic() < deadline, "the relay never started listening"
        await asyncio.sleep(0.05)


@postgres_only
def test_the_relay_listens_again_once_its_connection_is_cut(libpq_url):
    async def scenario() -> None:
        hub = Hub(max_clients=2)
        browser = hub.join()
        assert browser is not None
        relay = asyncio.create_task(live.relay(libpq_url, hub, retry=0.05))
        try:
            async with await psycopg.AsyncConnection.connect(libpq_url, autocommit=True) as db:
                # As when Postgres restarts, or the network drops the connection.
                await db.execute("SELECT pg_terminate_backend(%s)", [await listening_backend(db)])

                assert await asyncio.wait_for(browser.get(), 10) is None  # reconnect and refetch
                hub.leave(browser)
                reconnected = hub.join()
                assert reconnected is not None
                await db.execute("SELECT pg_notify(%s, 'after')", [live.CHANNEL])
                assert await asyncio.wait_for(reconnected.get(), 10) == "after"
        finally:
            relay.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await relay

    asyncio.run(scenario())
