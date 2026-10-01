"""API queries over one set of series, built once for the module: these tests only read."""

import datetime as dt
import re

import pandas as pd
import pytest

from heatwaves import queries
from heatwaves.models import Series
from heatwaves.sync import update_heatwaves
from tests.conftest import add_series, api_client, fresh_database, seasonal_temperatures

TODAY = dt.datetime.now(dt.UTC).date()


@pytest.fixture(scope="module")
def client():
    """A series in each state; at B01 1 m a heatwave from Jul 1 to Jul 10, 2021, and
    over B01 a satellite heatwave from Jul 5 to Jul 14.

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
    satellite = seasonal_temperatures("2003-01-01", TODAY - dt.timedelta(days=1), seed=3)
    satellite["2021-06-25":"2021-07-20"] = typical["2021-06-25":"2021-07-20"]
    satellite["2021-07-05":"2021-07-14"] += 2.5

    with fresh_database() as session_factory, session_factory() as session:
        for values, buoy_id, depth in (
            (heatwave, "A01", 1),
            (normal, "A01", 20),
            (above, "A01", 50),
            (offline, "B01", 1),
        ):
            update_heatwaves(session, add_series(session, values, buoy_id, depth))
        over_b01 = add_series(session, satellite, "B01", source="satellite")
        over_b01.latitude, over_b01.longitude, over_b01.distance_km = 43.125, -70.375, 7.5
        update_heatwaves(session, over_b01)
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


@pytest.mark.parametrize("endpoint", ["daily", "daily/values"])
def test_daily_series_defaults_to_the_year_to_the_newest_day(client, endpoint):
    days = client.get(f"/api/buoys/B01/1/{endpoint}").json()

    assert len(days) == 365
    assert days[-1]["date"] == (TODAY - dt.timedelta(days=10)).isoformat()


@pytest.mark.parametrize("endpoint", ["daily", "daily/values"])
def test_daily_series_rejects_a_reversed_or_early_range_and_a_series_without_a_normal(client, endpoint):
    reversed_range = f"start={TODAY}&end={TODAY - dt.timedelta(days=1)}"
    assert client.get(f"/api/buoys/A01/1/{endpoint}?{reversed_range}").status_code == 422
    assert client.get(f"/api/buoys/A01/1/{endpoint}?start=2000-12-31").status_code == 422
    assert client.get(f"/api/buoys/B01/20/{endpoint}").status_code == 404


def test_daily_series_goes_to_the_nearest_thousandth(client):
    response = client.get("/api/buoys/A01/20/daily?start=2021-01-01&end=2021-12-31")
    stored = seasonal_temperatures("2003-01-01", TODAY, seed=1)["2021"]

    assert [day["value"] for day in response.json()] == pytest.approx(stored.tolist(), abs=5e-4)
    # Every number, the normal, threshold and anomaly too, has three decimals at most.
    assert max(len(decimals) for decimals in re.findall(r"\.(\d+)", response.text)) == 3


def test_daily_values_are_the_daily_means_alone(client):
    # B01 at 1 m went offline ten days ago, so the last ten are gaps.
    query = f"start={TODAY - dt.timedelta(days=30)}&end={TODAY}"
    days = client.get(f"/api/buoys/B01/1/daily?{query}").json()
    values = client.get(f"/api/buoys/B01/1/daily/values?{query}").json()

    assert values == [{"date": day["date"], "value": day["value"]} for day in days]
    assert [day["value"] for day in values[-10:]] == [None] * 10
    satellite = client.get("/api/buoys/B01/0/daily/values?start=2021-07-01&end=2021-07-10").json()
    assert len(satellite) == 10 and None not in [day["value"] for day in satellite]


def test_daily_series_runs_from_2001_to_a_year_from_today(client):
    def daily(start: dt.date | str, end: dt.date | str):
        return client.get(f"/api/buoys/A01/1/daily?start={start}&end={end}")

    # A heatwave's page asks for two weeks past its onset, which can reach past today.
    ahead = daily(TODAY, TODAY + dt.timedelta(days=14)).json()
    assert len(ahead) == 15
    assert all(day["value"] is None and day["threshold"] > day["climatology"] for day in ahead[1:])
    longest = daily("2001-01-01", TODAY + dt.timedelta(days=365)).json()
    assert len(longest) == (TODAY - dt.date(2001, 1, 1)).days + 366

    assert daily("2000-12-31", "2001-12-31").status_code == 422
    assert daily(TODAY, TODAY + dt.timedelta(days=366)).status_code == 422
    # A default start counted back from this would be out of the calendar.
    assert client.get("/api/buoys/A01/1/daily?end=0001-01-01").status_code == 422


@pytest.mark.parametrize(
    "path",
    [
        "/api/events?year=0",
        "/api/events?year=99999",
        "/api/onsets?year=2000&depth=1",
        "/api/events?depth=-1",
        f"/api/events?depth={10**23}",
        f"/api/events/A01/{10**23}/2021-07-01",
        f"/api/buoys/A01/{10**23}/daily",
        f"/api/onsets?year=2021&depth={10**23}",
        f"/api/annual?depth={10**23}",
        f"/api/stripes?depth={10**23}",
        f"/api/agreement?depth={10**23}",
        f"/api/data/A01/{10**23}.csv",
    ],
)
def test_implausible_years_and_depths_are_rejected(client, path):
    # Before they reach the calendar or the database's integers.
    assert client.get(path).status_code == 422


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


def test_monthly_anomaly_needs_enough_days_from_each_series():
    def days(start: str, count: int, value: float) -> pd.Series:
        return pd.Series(value, index=pd.date_range(start, periods=count))

    months = queries.monthly_anomaly(
        [
            # January in full at +1; ten days of February, too few to count; March in full at +2.
            pd.concat(
                [days("2021-01-01", 31, 1.0), days("2021-02-01", 10, 3.0), days("2021-03-01", 31, 2.0)]
            ),
            # Twenty days of January at -1.
            days("2021-01-05", 20, -1.0),
        ]
    )

    assert pd.DatetimeIndex(months.index).strftime("%Y-%m").tolist() == ["2021-01", "2021-03"]
    assert months["anomaly"].tolist() == [0.0, 2.0]
    assert months["series"].tolist() == [2, 1]
    assert queries.monthly_anomaly([]).empty


def test_stripes_average_each_month_over_the_buoys(client):
    months = client.get("/api/stripes?depth=1").json()

    assert months[0]["month"] == "2003-01-01"
    assert [m["month"] for m in months] == sorted(m["month"] for m in months)
    by_month = {m["month"]: m for m in months}
    # Both buoys measure 1 m through 2021; B01's heatwave that July warms the month.
    assert by_month["2021-07-01"]["buoys"] == 2
    assert by_month["2021-07-01"]["anomaly"] > by_month["2021-06-01"]["anomaly"]


@pytest.mark.parametrize("depth", [0, 7])
def test_a_depth_no_buoy_measures_has_nothing_to_summarize(client, depth):
    # Depth 0 is the satellite's: B01's mustn't pass for a buoy depth.
    for path in ("annual", "stripes", "agreement"):
        response = client.get(f"/api/{path}?depth={depth}")
        assert (response.status_code, response.json()) == (200, [])
    year = client.get(f"/api/onsets?year=2021&depth={depth}")
    assert (year.status_code, year.json()["buoys"]) == (200, [])


def test_buoys_report_the_satellite_apart_from_the_depths(client):
    buoys = {buoy["id"]: buoy for buoy in client.get("/api/buoys").json()}

    assert buoys["A01"]["satellite"] is None
    satellite = buoys["B01"]["satellite"]
    assert (satellite["depth"], satellite["distance_km"], satellite["latitude"]) == (0, 7.5, 43.125)
    assert satellite["date"] == (TODAY - dt.timedelta(days=1)).isoformat()
    assert (
        satellite["erddap_url"]
        == "https://coastwatch.pfeg.noaa.gov/erddap/griddap/ncdcOisst21Agg_LonPM180.html"
    )
    assert buoys["B01"]["series"][0]["erddap_url"].endswith("/tabledap/B01_ocean_001m.html")


def test_daily_series_serves_the_satellite_at_depth_0(client):
    days = client.get("/api/buoys/B01/0/daily?start=2021-07-01&end=2021-07-10").json()

    assert len(days) == 10
    assert all(day["value"] > day["threshold"] for day in days[4:])


def test_agreement_compares_a_depth_with_the_satellite_over_days_both_observed(client):
    rows = {(row["buoy_id"], row["year"]): row for row in client.get("/api/agreement?depth=1").json()}

    assert {buoy for buoy, _ in rows} == {"B01"}  # A01 has no satellite series
    year = rows["B01", 2021]
    assert (year["both"], year["buoy_only"]) == (6, 4)  # Jul 5-10, and Jul 1-4
    assert year["satellite_only"] >= 4  # Jul 11-14, and any others
    assert year["both"] + year["satellite_only"] + year["buoy_only"] + year["neither"] == 365
