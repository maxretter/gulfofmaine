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
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from heatwaves import live, main, sync
from heatwaves.config import Settings
from heatwaves.live import (
    DaysMessage,
    Hub,
    JudgedHeatwave,
    OriginsMessage,
    ReadingMessage,
    RecomputedMessage,
    StatusMessage,
    address_key,
)
from heatwaves.models import Event, Series
from heatwaves.sources import Download, Reading, TabledapSource
from heatwaves.state import SeriesState, state_of
from heatwaves.sync import store, sync_series, update_heatwaves, update_origins
from tests.conftest import A01_SYNC, NOW, TODAY, add_series, recorded_erddap, seasonal_temperatures

# The sync judges each series' state on its clock's day (sync.update_heatwaves), stopped at NOW.
pytestmark = pytest.mark.usefixtures("stopped_clock")
BROWSER = "198.51.100.7"  # a browser's address, for the hub

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

    reading, status, days = messages
    assert reading == ReadingMessage(buoy="A01", depth=1, time=NOW, temperature=17.3)
    assert isinstance(status, StatusMessage)
    assert (status.previous_state, status.state) == ("normal", "heatwave")
    assert status.date == TODAY
    assert status.days_above == 8
    assert status.category is not None
    assert (series.latest_reading_at, series.latest_reading) == (NOW, 17.3)
    # The week re-read, with the heatwave in it.
    assert days == DaysMessage(buoy="A01", depth=1, first=warm.index[0].date(), last=TODAY, heatwaves=True)


def test_a_sync_announces_a_heatwave_in_progress_that_grows_or_changes(session, normal_until_yesterday):
    series = normal_until_yesterday
    warm = seasonal_temperatures(str(TODAY - dt.timedelta(days=7)), TODAY) + 2.5
    store(session, [series], download(series, warm[:-1]))

    # A day longer, in the same category: pages showing it would otherwise say it ended yesterday.
    longer, days = store(session, [series], download(series, warm[-1:]))

    assert isinstance(longer, StatusMessage)
    assert isinstance(days, DaysMessage) and days.heatwaves
    assert (longer.previous_state, longer.state) == ("heatwave", "heatwave")
    assert longer.previous_category == longer.category is not None
    assert (longer.date, longer.days_above) == (TODAY, 8)

    # Today's mean again, from more hours: the heatwave's intensity changes.
    warmer, _ = store(session, [series], download(series, warm[-1:] + 0.5))

    assert isinstance(warmer, StatusMessage)
    assert (warmer.previous_state, warmer.state, warmer.date) == ("heatwave", "heatwave", TODAY)
    assert warmer.previous_category == warmer.category


def test_a_sync_announces_a_heatwave_pausing_and_resuming_as_the_same_heatwave(
    session, normal_until_yesterday
):
    series = normal_until_yesterday
    days = seasonal_temperatures(str(TODAY - dt.timedelta(days=7)), TODAY)
    store(session, [series], download(series, days[:-1] + 2.5))
    [start] = session.scalars(select(Event.start_date).where(Event.end_date == TODAY - dt.timedelta(days=1)))

    # Today's mean so far is below the threshold: the heatwave is paused, not over.
    paused, _ = store(session, [series], download(series, days[-1:] - 2.0))

    assert isinstance(paused, StatusMessage)
    assert (paused.previous_state, paused.state, paused.date) == ("heatwave", "paused", TODAY)
    assert paused.category == paused.previous_category is not None

    # Today again, from more hours, above the threshold: the same heatwave goes on.
    resumed, _ = store(session, [series], download(series, days[-1:] + 2.5))

    assert isinstance(resumed, StatusMessage)
    assert (resumed.previous_state, resumed.state) == ("paused", "heatwave")
    assert resumed.previous_category == resumed.category == paused.category
    assert session.scalars(select(Event.start_date).where(Event.end_date == TODAY)).all() == [start]


def test_a_sync_announces_a_paused_heatwave_ending_once_nothing_can_be_joined_to_it(session):
    temperatures = seasonal_temperatures("2003-01-01", TODAY - dt.timedelta(days=3))
    temperatures.iloc[-12:] -= 2.0
    temperatures.iloc[-7:] += 4.5
    series = add_series(session, temperatures)
    update_heatwaves(session, series)
    session.commit()
    cool = seasonal_temperatures(str(TODAY - dt.timedelta(days=2)), TODAY) - 2.0

    (paused, _), still, (over, _) = (
        store(session, [series], download(series, cool[day : day + 1])) for day in range(3)
    )

    assert isinstance(paused, StatusMessage)
    assert (paused.previous_state, paused.state) == ("heatwave", "paused")
    assert paused.category is not None
    # A second day below changes only that day on the feed: a spell from tomorrow could still be joined on.
    second = cool.index[1].date()
    assert still == [DaysMessage(buoy="A01", depth=1, first=second, last=second, heatwaves=False)]
    # After a third, one would start too late.
    assert isinstance(over, StatusMessage)
    assert (over.previous_state, over.state) == ("paused", "normal")
    assert (over.previous_category, over.category) == (paused.category, None)


def test_a_sync_that_changes_no_day_announces_nothing(session, normal_until_yesterday):
    series = normal_until_yesterday
    warm = seasonal_temperatures(str(TODAY - dt.timedelta(days=7)), TODAY) + 2.5
    store(session, [series], download(series, warm, Reading(NOW, 17.3)))

    # The days before today again, as when their rows are stamped anew, with an older reading from them.
    yesterday = NOW - dt.timedelta(days=1)
    assert store(session, [series], download(series, warm[:-1], Reading(yesterday, 17.0))) == []
    assert series.latest_reading == 17.3

    # A day before the heatwave revised, still well below the threshold: that day alone.
    eighth = TODAY - dt.timedelta(days=8)
    cool = seasonal_temperatures(str(eighth), eighth) - 2.1
    assert store(session, [series], download(series, cool)) == [
        DaysMessage(buoy="A01", depth=1, first=eighth, last=eighth, heatwaves=False)
    ]


def test_only_temperature_readings_and_states_go_on_the_feed(session):
    history = pd.Series(31.0, index=pd.date_range("2003-01-01", TODAY - dt.timedelta(days=1)))
    salinity = add_series(session, history, variable="salinity")
    update_heatwaves(session, salinity)
    today = pd.Series([31.2], index=[pd.Timestamp(TODAY)])

    messages = store(session, [salinity], download(salinity, today, Reading(NOW, 31.2)))

    # Its new day, which the heatwave's temperature-salinity diagram shows.
    assert messages == [DaysMessage(buoy="A01", depth=1, first=TODAY, last=TODAY, heatwaves=False)]
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


def test_a_sync_announces_each_heatwave_whose_origin_or_evidence_changes(session):
    # At A01 50 m, a heatwave from Apr 14, 2025, whose evidence reads A01 1 m around it.
    calm = slice("2025-01-01", "2025-05-31")  # noise-free, so the heatwave's edges are exact

    def warmed(offset: float, seed: int, heatwave: slice | None = None) -> pd.Series:
        values = seasonal_temperatures("2003-01-01", "2025-06-30", seed=seed) + offset
        values[calm] = seasonal_temperatures("2003-01-01", "2025-06-30", noise=0)[calm] + offset
        if heatwave is not None:
            values[heatwave] += 2.5
        return values

    at_50 = add_series(session, warmed(0, 0, slice("2025-04-14", "2025-04-28")), "A01", 50)
    surface = warmed(6, 1)
    at_1 = add_series(session, surface, "A01", 1)
    for series in at_50, at_1:
        update_heatwaves(session, series)
    [april] = update_origins(session)
    assert (april.buoy, april.depth, april.start) == ("A01", 50, dt.date(2025, 4, 14))

    # 1 m three degrees cooler in the weeks before the onset: less stratified before it.
    cooler = surface["2025-03-20":"2025-04-10"] - 3
    days, origins = store(session, [at_1], download(at_1, cooler))
    assert isinstance(days, DaysMessage)
    assert (days.buoy, days.depth) == ("A01", 1)
    assert (days.first, days.last) == (dt.date(2025, 3, 20), dt.date(2025, 4, 10))
    assert origins == OriginsMessage(heatwaves=[april])

    # The same days again: judged again, and found as they were.
    assert store(session, [at_1], download(at_1, cooler)) == []


def test_a_new_satellite_day_goes_out_at_each_buoy(session):
    # The satellite has no readings, and its states stay as they were.
    history = seasonal_temperatures("2003-01-01", TODAY - dt.timedelta(days=1))
    history.iloc[-12:] -= 2.0
    cells = [add_series(session, history, buoy, source="satellite") for buoy in ("A01", "B01")]
    for cell in cells:
        update_heatwaves(session, cell)
    today = pd.DataFrame({"value": [11.0], "hours": [None]}, index=pd.DatetimeIndex([TODAY], name="date"))

    messages = store(session, cells, Download(TODAY, TODAY, {cell.id: today for cell in cells}, NOW))

    assert messages == [
        DaysMessage(buoy=buoy, depth=0, first=TODAY, last=TODAY, heatwaves=False) for buoy in ("A01", "B01")
    ]


def test_a_heatwave_revised_in_the_past_goes_out_at_a_depth_without_origins(session):
    temperatures = seasonal_temperatures("2003-01-01", TODAY - dt.timedelta(days=1))
    temperatures.iloc[-12:] -= 2.0
    july = slice("2025-07-01", "2025-07-10")
    warm = temperatures.copy()
    warm[july] += 3.0
    series = add_series(session, warm)  # at 1 m
    update_heatwaves(session, series)
    session.commit()
    [(start, end)] = session.execute(
        select(Event.start_date, Event.end_date).where(Event.end_date >= dt.date(2025, 7, 1)).limit(1)
    ).all()
    assert start <= dt.date(2025, 7, 10)

    # Reprocessed upstream, the warm spell is gone: no state changes, and no origin rests on 1 m alone.
    messages = store(session, [series], download(series, temperatures[july]))

    first, last = min(start, dt.date(2025, 7, 1)), max(end, dt.date(2025, 7, 10))
    assert messages == [DaysMessage(buoy="A01", depth=1, first=first, last=last, heatwaves=True)]


def test_a_recompute_tells_the_feed_that_anything_may_have_changed(monkeypatch, session_factory, tmp_path):
    published: list[live.Message] = []
    monkeypatch.setattr(live, "publish", lambda session, messages: published.extend(messages))
    monkeypatch.setattr("heatwaves.db.SessionLocal", session_factory)
    monkeypatch.setattr(sync, "settings", dataclasses.replace(sync.settings, products_dir=tmp_path))

    assert sync.main(["--recompute"]) == 0

    assert published == [RecomputedMessage()]


def test_a_message_lists_as_many_heatwaves_as_a_notify_carries():
    longest = JudgedHeatwave(buoy="ABCDEFGH", depth=1000, start=dt.date(2025, 12, 1), end=dt.date(2026, 3, 1))
    heatwaves = [longest] * (2 * live.ORIGINS_PER_MESSAGE + 1)

    messages = live.origins_messages(heatwaves)

    assert [len(message.heatwaves) for message in messages] == [100, 100, 1]
    # Postgres takes a payload of under 8000 bytes.
    assert len(messages[0].model_dump_json().encode()) < 8000
    assert live.origins_messages([]) == []


@pytest.mark.parametrize(
    ("latest", "days_above", "heatwave", "expected"),
    [
        (None, 0, None, ("no_data", None)),
        (TODAY - dt.timedelta(days=4), 9, (2, TODAY - dt.timedelta(days=4)), ("offline", None)),
        (TODAY - dt.timedelta(days=3), 9, (2, TODAY - dt.timedelta(days=3)), ("heatwave", 2)),
        # The newest heatwave ended two days ago: as far back as a spell from tomorrow can join it.
        (TODAY, 0, (2, TODAY - dt.timedelta(days=2)), ("paused", 2)),
        (TODAY, 0, (2, TODAY - dt.timedelta(days=3)), ("normal", None)),
        # Three days back above, after a dip of two.
        (TODAY, 3, (3, TODAY - dt.timedelta(days=5)), ("paused", 3)),
        (TODAY, 3, (3, TODAY - dt.timedelta(days=6)), ("above_threshold", None)),
        (TODAY, 3, None, ("above_threshold", None)),
        (TODAY, 0, None, ("normal", None)),
    ],
)
def test_state_rules(latest, days_above, heatwave, expected):
    series = Series(latest_date=latest, days_above=days_above, latest_climatology=12.0)
    event = Event(category=heatwave[0], end_date=heatwave[1]) if heatwave else None

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


def test_the_feed_turns_away_an_address_holding_its_share_of_places(monkeypatch, caplog):
    # A script needn't send an Origin, so without this one client could take every place.
    monkeypatch.setattr(live.hub, "max_per_address", 1)

    with TestClient(main.app) as client, client.websocket_connect("/api/live"):
        with pytest.raises(WebSocketDisconnect) as refused, client.websocket_connect("/api/live"):
            pass
        assert refused.value.code == 1013  # as when the feed is full
        assert len(live.hub.clients) == 1
    assert "LIVE_MAX_PER_ADDRESS" in caplog.text


def test_an_address_at_its_limit_leaves_the_rest_of_the_feed_open():
    hub = Hub(max_clients=10, max_per_address=2)
    first, second = hub.join(BROWSER), hub.join(BROWSER)
    assert first is not None and second is not None

    assert hub.join(BROWSER) is None
    assert hub.join("203.0.113.9") is not None
    hub.leave(first)
    assert hub.join(BROWSER) is not None
    assert hub.per_address == {BROWSER: 2, "203.0.113.9": 1}


@pytest.mark.parametrize(
    ("one", "other", "shared"),
    [
        ("198.51.100.7", "198.51.100.8", False),
        ("2001:db8:1:2::a", "2001:db8:1:2:ffff::b", True),  # one /64: usually one household or phone
        ("2001:db8:1:2::a", "2001:db8:1:3::a", False),
        ("::ffff:198.51.100.7", BROWSER, True),  # an IPv4 address written as IPv6
        ("testclient", "testclient", True),  # not an address at all
    ],
)
def test_ipv6_addresses_share_a_limit_by_their_64(one, other, shared):
    hub = Hub(max_clients=10, max_per_address=1)

    assert hub.join(one) is not None
    assert (hub.join(other) is None) is shared
    assert (address_key(one) == address_key(other)) is shared


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


@pytest.mark.parametrize(
    ("headers", "refused"),
    [
        # DNS rebinding: another site's name, pointed at this server, so its page's Origin matches its Host.
        ({"origin": "http://rebound.example:8000", "host": "rebound.example:8000"}, True),
        ({"origin": "http://testserver"}, True),
        ({"origin": "https://GulfOfMaine.example", "host": "gulfofmaine.example"}, False),
        ({"origin": "http://localhost:8000", "host": "localhost:8000"}, False),
        ({"origin": "https://partner.example"}, False),  # in LIVE_ORIGINS
        ({}, False),  # not a browser
    ],
)
def test_with_live_hosts_the_sites_own_pages_are_those_at_them(monkeypatch, headers, refused):
    monkeypatch.setattr(
        live,
        "settings",
        dataclasses.replace(
            live.settings,
            live_origins=frozenset({"https://partner.example"}),
            live_hosts=frozenset({"gulfofmaine.example", "localhost:8000"}),
        ),
    )
    monkeypatch.setattr(live, "PING_EVERY", 0.1)

    with TestClient(main.app) as client:
        if refused:
            with (
                pytest.raises(WebSocketDisconnect) as closed,
                client.websocket_connect("/api/live", headers=headers),
            ):
                pass
            assert closed.value.code == 1008
        else:
            with client.websocket_connect("/api/live", headers=headers) as browser:
                assert browser.receive_json()["type"] == "ping"


def test_live_origins_and_hosts_are_comma_separated_lists(monkeypatch):
    monkeypatch.setenv("LIVE_ORIGINS", " https://Partner.example/, http://localhost:5173,")
    monkeypatch.setenv("LIVE_HOSTS", "GulfOfMaine.example, localhost:8000,")

    settings = Settings.from_env()
    assert settings.live_origins == {"https://partner.example", "http://localhost:5173"}
    assert settings.live_hosts == {"gulfofmaine.example", "localhost:8000"}


def test_a_browser_that_falls_behind_is_disconnected_to_refetch():
    hub = Hub(max_clients=2, max_per_address=2)
    queue = hub.join(BROWSER)
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
        hub = Hub(max_clients=2, max_per_address=2)
        browser = hub.join(BROWSER)
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
            reconnected = hub.join(BROWSER)
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
def test_a_full_origins_message_goes_out(session, libpq_url):
    longest = JudgedHeatwave(buoy="ABCDEFGH", depth=1000, start=dt.date(2025, 12, 1), end=dt.date(2026, 3, 1))
    [message] = live.origins_messages([longest] * live.ORIGINS_PER_MESSAGE)
    with psycopg.connect(libpq_url, autocommit=True) as listener:
        listener.execute(f"LISTEN {live.CHANNEL}")

        live.publish(session, [message])
        session.commit()

        [notice] = listener.notifies(timeout=5, stop_after=1)
    assert OriginsMessage.model_validate_json(notice.payload) == message


@postgres_only
def test_a_recompute_goes_out_once_it_commits(monkeypatch, session_factory, libpq_url, tmp_path):
    monkeypatch.setattr("heatwaves.db.SessionLocal", session_factory)
    monkeypatch.setattr(sync, "settings", dataclasses.replace(sync.settings, products_dir=tmp_path))
    with psycopg.connect(libpq_url, autocommit=True) as listener:
        listener.execute(f"LISTEN {live.CHANNEL}")

        assert sync.main(["--recompute"]) == 0

        [notice] = listener.notifies(timeout=5, stop_after=1)
    assert json.loads(notice.payload) == {"type": "recomputed"}


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
        hub = Hub(max_clients=2, max_per_address=2)
        browser = hub.join(BROWSER)
        assert browser is not None
        relay = asyncio.create_task(live.relay(libpq_url, hub, retry=0.05))
        try:
            async with await psycopg.AsyncConnection.connect(libpq_url, autocommit=True) as db:
                # As when Postgres restarts, or the network drops the connection.
                await db.execute("SELECT pg_terminate_backend(%s)", [await listening_backend(db)])

                assert await asyncio.wait_for(browser.get(), 10) is None  # reconnect and refetch
                hub.leave(browser)
                reconnected = hub.join(BROWSER)
                assert reconnected is not None
                await db.execute("SELECT pg_notify(%s, 'after')", [live.CHANNEL])
                assert await asyncio.wait_for(reconnected.get(), 10) == "after"
        finally:
            relay.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await relay

    asyncio.run(scenario())
