"""The origin labels through the sync and the API, over one synthetic region built once for the module."""

import numpy as np
import pandas as pd
import pytest

from heatwaves import origin
from heatwaves.sync import update_heatwaves, update_origins
from tests.conftest import add_series, api_client, fresh_database, seasonal_temperatures

END = "2021-06-30"
AROUND = slice("2021-01-01", "2021-05-31")  # set to the noise-free normal, so each heatwave's edges are exact


def warmed(offset: float, seed: int, heatwave: slice | None = None) -> pd.Series:
    """A seasonal series `offset` degrees warmer than the default, and 2.5 more during `heatwave`."""
    values = seasonal_temperatures("2003-01-01", END, seed=seed) + offset
    values[AROUND] = seasonal_temperatures("2003-01-01", END, noise=0)[AROUND] + offset
    if heatwave is not None:
        values[heatwave] += 2.5
    return values


@pytest.fixture(scope="module")
def client():
    """At A01 50 m, a heatwave from Apr 14 to 28, 2021, with every signal pointing offshore.

    Salty water at 50 m; 1 m six degrees warmer, and staying 3.5 degrees warmer
    through the heatwave; M01 warm at 100 m from Mar 20 to Apr 5; and a
    heatwave at M01 50 m two months earlier, from Feb 13 to 22.
    """
    days = pd.date_range("2003-01-01", END)
    salinity = pd.Series(32 + np.random.default_rng(9).normal(0, 0.1, len(days)), index=days)
    salinity[AROUND] = 32.3
    with fresh_database() as session_factory, session_factory() as session:
        for values, buoy_id, depth in (
            (warmed(0, 0, slice("2021-04-14", "2021-04-28")), "A01", 50),
            (warmed(6, 1), "A01", 1),
            (warmed(0, 2, slice("2021-02-13", "2021-02-22")), "M01", 50),
            (warmed(-3, 3, slice("2021-03-20", "2021-04-05")), "M01", 100),
        ):
            update_heatwaves(session, add_series(session, values, buoy_id, depth))
        update_heatwaves(session, add_series(session, salinity, "A01", 50, variable="salinity"))
        update_origins(session)
        session.commit()
        with api_client(session_factory) as client:
            yield client


def test_events_carry_their_origin_at_the_depths_that_get_one(client):
    events = {
        (event["buoy_id"], event["depth"], event["start_date"]): event["origin"]
        for event in client.get("/api/events").json()
    }

    assert events["A01", 50, "2021-04-14"] == "offshore"
    assert events["M01", 100, "2021-03-20"] is None  # below the depths heatwaves.origin covers
    assert [e["start_date"] for e in client.get("/api/events?buoy_id=A01&origin=offshore").json()] == [
        "2021-04-14"
    ]
    assert client.get("/api/events?buoy_id=A01&origin=surface").json() == []
    assert client.get("/api/events?origin=tropical").status_code == 422


def test_one_event_with_its_evidence_day_by_day(client):
    event = client.get("/api/events/a01/50/2021-04-14").json()

    assert (event["end_date"], event["origin"]) == ("2021-04-28", "offshore")
    evidence = event["evidence"]
    assert set(evidence["votes"].values()) == {"offshore"}
    assert evidence["salinity_anomaly"] == pytest.approx(0.3, abs=0.05)
    assert (evidence["stratification_before"], evidence["stratification_after"]) == pytest.approx((6, 3.5))
    assert (evidence["offshore_onset"], evidence["western_onset"]) == ("2021-02-13", "2021-04-14")

    signals = event["signals"]
    assert len(signals) == origin.BEFORE + 1 + origin.AFTER
    assert (signals[0]["date"], signals[-1]["date"]) == ("2021-03-15", "2021-04-28")
    onset = signals[origin.BEFORE]
    assert onset["anomaly"] == pytest.approx(2.5, abs=0.2)
    assert onset["stratification"] == pytest.approx(3.5)
    assert [day["deep_heatwave"] for day in signals].count(True) == 17  # Mar 20 to Apr 5
    assert not any(day["surface_heatwave"] for day in signals)
    assert onset["surface_anomaly"] == pytest.approx(0, abs=0.3)  # 1 m is warm, but no warmer than its normal
    assert event["onsets"] == [
        {"buoy_id": "M01", "date": "2021-02-13", "group": "offshore"},
        {"buoy_id": "A01", "date": "2021-04-14", "group": "western"},
    ]


def test_an_event_without_an_origin_has_no_evidence(client):
    event = client.get("/api/events/M01/100/2021-03-20").json()

    assert (event["evidence"], event["signals"], event["onsets"]) == (None, [], [])
    assert client.get("/api/events/A01/50/2021-04-15").status_code == 404


def test_onsets_follow_each_buoy_through_a_year(client):
    year = client.get("/api/onsets?year=2021&depth=50").json()

    assert (year["dates"][0], year["dates"][-1], len(year["dates"])) == ("2021-01-01", "2021-12-31", 365)
    a01, m01 = year["buoys"]
    assert (a01["buoy_id"], a01["onset"], a01["origin"]) == ("A01", "2021-04-14", "offshore")
    assert (m01["buoy_id"], m01["onset"]) == ("M01", "2021-02-13")
    assert sum(a01["heatwave"]) == 15
    assert a01["anomaly"][year["dates"].index("2021-04-20")] == pytest.approx(2.5, abs=0.2)
    assert a01["anomaly"][-1] is None  # the record ends in June


def test_onsets_need_a_measured_depth_and_a_plausible_year(client):
    assert client.get("/api/onsets?year=2021&depth=7").status_code == 404
    assert client.get("/api/onsets?year=1999&depth=50").status_code == 422


def test_origin_rules_are_the_module_constants(client):
    rules = client.get("/api/origin/rules").json()

    assert (rules["salty"], rules["margin"], rules["deep_depths"]) == (
        origin.SALTY,
        origin.MARGIN,
        list(origin.DEEP_DEPTHS),
    )


def test_daily_serves_salinity_by_name(client):
    days = client.get("/api/buoys/A01/50/daily?variable=salinity&start=2021-04-01&end=2021-04-03").json()

    assert [day["value"] for day in days] == pytest.approx([32.3] * 3)
    assert all(day["anomaly"] == pytest.approx(0.3, abs=0.05) for day in days)
    assert client.get("/api/buoys/A01/1/daily?variable=salinity").status_code == 404
    assert client.get("/api/buoys/A01/50/daily?variable=oxygen").status_code == 422
