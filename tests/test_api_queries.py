"""API queries over one set of series, built once for the module: these tests only read."""

import datetime as dt

import pytest

from heatwaves.models import Series
from heatwaves.sync import update_heatwaves
from tests.conftest import add_series, api_client, fresh_database, seasonal_temperatures

TODAY = dt.datetime.now(dt.UTC).date()


@pytest.fixture(scope="module")
def client():
    """A series in each state, and at B01 1 m a heatwave from Jul 1 to Jul 10, 2021.

    Days either side of each heatwave are set to normal, so its edges are exact.
    """
    typical = seasonal_temperatures("2003-01-01", TODAY, noise=0)
    heatwave = seasonal_temperatures("2003-01-01", TODAY)
    heatwave.iloc[-12:] = typical.iloc[-12:]
    heatwave.iloc[-8:] += 2.5
    normal = seasonal_temperatures("2003-01-01", TODAY, seed=1)
    normal.iloc[-3:] = typical.iloc[-3:]
    above = normal.copy()
    above.iloc[-2:] += 2.5
    offline = seasonal_temperatures("2003-01-01", TODAY - dt.timedelta(days=10), seed=2)
    offline["2021-06-25":"2021-07-15"] = typical["2021-06-25":"2021-07-15"]
    offline["2021-07-01":"2021-07-10"] += 2.5

    with fresh_database() as session_factory, session_factory() as session:
        for values, buoy_id, depth in (
            (heatwave, "A01", 1),
            (normal, "A01", 20),
            (above, "A01", 50),
            (offline, "B01", 1),
        ):
            update_heatwaves(session, add_series(session, values, buoy_id, depth))
        # A series the sync has created but found no data for yet.
        empty = Series(
            buoy_id="B01", depth=20, variable="temperature", source="buoy", dataset_id="B01_ocean_020m"
        )
        session.add(empty)
        update_heatwaves(session, empty)
        session.commit()
        with api_client(session_factory) as client:
            yield client


def test_buoys_report_every_state(client):
    buoys = client.get("/api/buoys").json()

    states = {
        (buoy["id"], s["depth"]): (s["state"], s["days_above"]) for buoy in buoys for s in buoy["series"]
    }
    assert states == {
        ("A01", 1): ("heatwave", 8),
        ("A01", 20): ("normal", 0),
        ("A01", 50): ("above_threshold", 2),
        ("B01", 1): ("offline", 0),
        ("B01", 20): ("no_data", 0),
    }


def test_one_buoy_by_id(client):
    assert [s["depth"] for s in client.get("/api/buoys/b01").json()["series"]] == [1, 20]
    assert client.get("/api/buoys/Z99").status_code == 404


def test_daily_series_defaults_to_the_year_to_the_newest_day(client):
    days = client.get("/api/buoys/B01/1/daily").json()

    assert len(days) == 365
    assert days[-1]["date"] == (TODAY - dt.timedelta(days=10)).isoformat()


def test_daily_series_rejects_a_reversed_range_and_a_series_without_a_normal(client):
    reversed_range = f"start={TODAY}&end={TODAY - dt.timedelta(days=1)}"
    assert client.get(f"/api/buoys/A01/1/daily?{reversed_range}").status_code == 422
    assert client.get("/api/buoys/B01/20/daily").status_code == 404


def test_events_filter_by_buoy_depth_year_and_category(client):
    def events(query: str = "") -> list[dict]:
        return client.get(f"/api/events?{query}").json()

    starts = [event["start_date"] for event in events()]
    assert starts == sorted(starts, reverse=True)
    assert [
        (e["buoy_id"], e["depth"], e["start_date"], e["end_date"], e["duration"])
        for e in events("buoy_id=b01")
    ] == [("B01", 1, "2021-07-01", "2021-07-10", 10)]
    assert {e["depth"] for e in events("depth=1")} == {1}
    assert all(e["start_date"] <= "2021-12-31" and e["end_date"] >= "2021-01-01" for e in events("year=2021"))
    assert all(e["category"] >= 3 for e in events("min_category=3"))
    assert client.get("/api/events?min_category=5").status_code == 422


def test_annual_counts_heatwave_and_observed_days(client):
    years = {(row["buoy_id"], row["year"]): row for row in client.get("/api/annual?depth=1").json()}

    assert (years["B01", 2021]["heatwave_days"], years["B01", 2021]["observed_days"]) == (10, 365)
    assert years["A01", TODAY.year]["heatwave_days"] >= 8
