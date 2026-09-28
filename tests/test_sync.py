"""The sync against recorded ERDDAP responses (tests/data, fetched from
data.neracoos.org on 2026-09-28), served through httpx's mock transport."""

import datetime as dt
from pathlib import Path
from urllib.parse import unquote

import httpx
import pytest
from sqlalchemy import select

from heatwaves.erddap import Erddap
from heatwaves.models import DailyMean, Event
from heatwaves.sync import sync_series
from tests.conftest import add_series, seasonal_temperatures

DATA = Path(__file__).parent / "data"


def recorded_erddap(requests: list[str], *, nothing_new: bool = False) -> Erddap:
    def respond(request: httpx.Request) -> httpx.Response:
        url = unquote(str(request.url))
        requests.append(url)
        if nothing_new:
            return httpx.Response(404, content=(DATA / "no_match.txt").read_bytes())
        if 'orderByMax("time_modified")' in url:
            return httpx.Response(200, content=(DATA / "newest.json").read_bytes())
        if 'orderByMinMax("time")' in url:
            return httpx.Response(200, content=(DATA / "span.json").read_bytes())
        if ".nc?" in url:
            return httpx.Response(200, content=(DATA / "A01_ocean_001m.nc").read_bytes())
        return httpx.Response(500)

    client = httpx.Client(transport=httpx.MockTransport(respond))
    return Erddap("https://data.neracoos.org/erddap", client)


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

    assert sync_series(session, recorded_erddap(requests), series)

    newest, span, data = requests
    # Two days of overlap behind the stored high-water mark...
    assert "time_modified>2026-09-24T12:00:00Z" in newest
    assert "time_modified<=2026-09-28T16:32:11Z" in span
    # ...then whole days, covering every row that changed.
    assert data.startswith("https://data.neracoos.org/erddap/tabledap/A01_ocean_001m.nc?time,temperature,")
    assert "time>=2026-09-24T00:00:00Z&time<2026-09-29T00:00:00Z" in data

    daily = dict(session.execute(select(DailyMean.date, DailyMean.temperature)).all())
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

    assert not sync_series(session, recorded_erddap(requests, nothing_new=True), series)

    assert len(requests) == 1
    assert series.synced_at is not None
    assert series.modified_through == dt.datetime(2026, 9, 26, 12, tzinfo=dt.UTC)
    assert session.scalars(select(Event)).all() == events_before
