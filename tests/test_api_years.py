"""Heatwave days per year, and a year at every buoy, over heatwaves set by hand."""

import datetime as dt

import pandas as pd
import pytest

from heatwaves.models import Event, Series
from tests.conftest import add_series, api_client, fresh_database


def observed(*spans: tuple[str, str]) -> pd.Series:
    """A daily mean on every day of each span."""
    return pd.concat(pd.Series(10.0, index=pd.date_range(start, end)) for start, end in spans)


def heatwave(series: Series, start: str, end: str, category: int = 1, origin: str | None = None) -> Event:
    first, last = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    return Event(
        series_id=series.id,
        start_date=first,
        end_date=last,
        peak_date=first,
        max_intensity=2.0,
        mean_intensity=1.5,
        category=category,
        origin=origin,
    )


@pytest.fixture(scope="module")
def client():
    """At A01, a heatwave at 1 m from Dec 25, 2020 to Jan 5, 2021, overlapping a
    Strong one at 20 m from Dec 30 to Jan 10 labeled Offshore, and at 20 m
    another from Jul 1 to 10, 2021, labeled Surface; at B01 1 m, a Severe one
    on Jul 1 and 2, 2021; and over A01 a satellite heatwave through March 2021.

    A01 had data at 1 m through 2021 and the first half of 2020, at 20 m the
    rest of 2020, and at both in December 2020 and January 2021.
    """
    with fresh_database() as session_factory, session_factory() as session:
        a01_1 = add_series(
            session, observed(("2020-01-01", "2020-06-30"), ("2020-12-01", "2021-12-31")), "A01", 1
        )
        a01_20 = add_series(session, observed(("2020-07-01", "2021-01-31")), "A01", 20)
        b01_1 = add_series(session, observed(("2021-01-01", "2021-12-31")), "B01", 1)
        over_a01 = add_series(session, observed(("2021-01-01", "2021-12-31")), "A01", source="satellite")
        session.add_all(
            [
                heatwave(a01_1, "2020-12-25", "2021-01-05"),
                heatwave(a01_20, "2020-12-30", "2021-01-10", category=2, origin="offshore"),
                heatwave(a01_20, "2021-07-01", "2021-07-10", origin="surface"),
                heatwave(b01_1, "2021-07-01", "2021-07-02", category=3),
                heatwave(over_a01, "2021-03-01", "2021-03-31"),
            ]
        )
        session.commit()
        with api_client(session_factory) as client:
            yield client


def annual(client, query: str = "") -> dict[tuple[str, int], tuple[int, int]]:
    """Heatwave days and observed days by buoy and year."""
    rows = client.get(f"/api/annual?{query}").json()
    return {(row["buoy_id"], row["year"]): (row["heatwave_days"], row["observed_days"]) for row in rows}


def test_annual_counts_each_depth_apart(client):
    # A heatwave over New Year counts in both years.
    assert annual(client, "depth=1") == {
        ("A01", 2020): (7, 213),
        ("A01", 2021): (5, 365),
        ("B01", 2021): (2, 365),
    }
    assert annual(client, "depth=20") == {("A01", 2020): (2, 184), ("A01", 2021): (20, 31)}
    assert {row["depth"] for row in client.get("/api/annual?depth=20").json()} == {20}


def test_annual_at_every_depth_counts_a_day_once(client):
    # Dec 30 and 31 were in heatwaves at both depths, as were Jan 1 to 5; and
    # A01 observed all of 2020 between its two depths, though neither alone.
    assert annual(client) == {("A01", 2020): (7, 366), ("A01", 2021): (20, 365), ("B01", 2021): (2, 365)}
    assert {row["depth"] for row in client.get("/api/annual").json()} == {None}


def test_annual_counts_the_heatwaves_the_event_filters_pick(client):
    assert annual(client, "min_category=2") == {
        ("A01", 2020): (2, 366),
        ("A01", 2021): (10, 365),
        ("B01", 2021): (2, 365),
    }
    assert annual(client, "depth=20&origin=surface") == {("A01", 2020): (0, 184), ("A01", 2021): (10, 31)}
    assert client.get("/api/annual?min_category=5").status_code == 422
    assert client.get("/api/annual?origin=tropical").status_code == 422


def test_annual_leaves_the_satellite_out(client):
    # Its March heatwave would add 31 days to A01's 2021.
    assert annual(client)["A01", 2021] == (20, 365)
    assert client.get("/api/annual?depth=0").json() == []


def test_onsets_give_each_day_its_heatwave(client):
    year = client.get("/api/onsets?year=2021&depth=20").json()
    (a01,) = year["buoys"]

    # The heatwave carried over from 2020 comes first, whole.
    assert [(h["start_date"], h["end_date"], h["duration"], h["origin"]) for h in a01["heatwaves"]] == [
        ("2020-12-30", "2021-01-10", 12, "offshore"),
        ("2021-07-01", "2021-07-10", 10, "surface"),
    ]
    day = {date: start for date, start in zip(year["dates"], a01["heatwave"], strict=True)}
    assert (day["2021-01-01"], day["2021-01-10"], day["2021-01-11"]) == ("2020-12-30", "2020-12-30", None)
    assert (day["2021-06-30"], day["2021-07-01"], day["2021-07-10"]) == (None, "2021-07-01", "2021-07-01")
    assert len([start for start in a01["heatwave"] if start]) == 20
    assert all(anomaly is None for anomaly in a01["anomaly"])  # no normal yet


def test_onsets_keep_to_the_depth_and_the_buoys(client):
    year = client.get("/api/onsets?year=2020&depth=1").json()

    assert [b["buoy_id"] for b in year["buoys"]] == ["A01", "B01"]
    a01, b01 = year["buoys"]
    # Running into 2021, it's whole in 2020's list too.
    assert [(h["start_date"], h["end_date"]) for h in a01["heatwaves"]] == [("2020-12-25", "2021-01-05")]
    assert (a01["heatwave"].count("2020-12-25"), year["dates"][-1]) == (7, "2020-12-31")
    assert (b01["heatwaves"], set(b01["heatwave"])) == ([], {None})
