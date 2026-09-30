"""/healthz: whether the sync job is keeping the buoys still reporting current."""

import datetime as dt

from heatwaves.models import Buoy, Series
from heatwaves.stations import buoy_series, satellite_series

TODAY = dt.datetime.now(dt.UTC).date()
RETIRED = dt.date(2025, 9, 17)  # M01's last day


def add(
    session,
    hours_since_sync: float | None,
    buoy_id: str = "A01",
    depth: int = 1,
    variable: str = "temperature",
    source: str = "buoy",
    latest: dt.date | None = TODAY,
) -> None:
    """A series whose newest day is `latest`, last synced `hours_since_sync` ago (None: never)."""
    if session.get(Buoy, buoy_id) is None:
        session.add(Buoy(id=buoy_id, name="Test Buoy"))
    spec = satellite_series(buoy_id) if source == "satellite" else buoy_series(buoy_id, depth, variable)
    synced_at = None
    if hours_since_sync is not None:
        synced_at = dt.datetime.now(dt.UTC) - dt.timedelta(hours=hours_since_sync)
    session.add(
        Series(
            buoy_id=buoy_id,
            depth=spec.depth,
            variable=spec.variable,
            source=spec.source,
            dataset_id=spec.dataset_id,
            latest_date=latest,
            synced_at=synced_at,
        )
    )
    session.commit()


def test_a_retired_buoy_behind_is_listed_without_failing(client, session):
    add(session, 0.1)
    add(session, 6, "M01", 100, latest=RETIRED)  # its dataset gone from NERACOOS, say

    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["stale"] == ["M01 100 m temperature (buoy)"]


def test_the_satellite_behind_is_listed_without_failing(client, session):
    add(session, 0.1)
    add(session, 6, source="satellite", latest=TODAY - dt.timedelta(days=1))  # CoastWatch down

    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json()["stale"] == ["A01 0 m temperature (satellite)"]


def test_one_buoy_behind_is_listed_without_failing(client, session):
    add(session, 0.1)
    add(session, 6, "B01", 20)

    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json()["stale"] == ["B01 20 m temperature (buoy)"]


def test_fails_once_no_buoy_still_reporting_has_synced(client, session):
    add(session, 6)
    add(session, 5, "B01", 20)
    # Syncing the others doesn't make up for it.
    add(session, 0.1, "M01", 100, latest=RETIRED)
    add(session, 0.1, source="satellite")

    response = client.get("/healthz")

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "stale"
    assert body["stale"] == ["A01 1 m temperature (buoy)", "B01 20 m temperature (buoy)"]
    since = {
        key: dt.datetime.now(dt.UTC) - dt.datetime.fromisoformat(body[key])
        for key in ("last_sync", "oldest_sync")
    }
    assert dt.timedelta(hours=5) < since["last_sync"] < dt.timedelta(hours=6)  # B01's
    assert since["oldest_sync"] > dt.timedelta(hours=6)  # A01's


def test_buoys_no_longer_reporting_dont_count(client, session):
    # Synced, but nothing on the site is current: A01 has been offline for four days, M01 is retired.
    add(session, 0.1, latest=TODAY - dt.timedelta(days=4))
    add(session, 0.1, "M01", 100, latest=RETIRED)

    response = client.get("/healthz")

    assert response.status_code == 503
    assert response.json()["last_sync"] is None
    assert response.json()["stale"] == []


def test_series_never_synced_are_listed(client, session):
    add(session, None, latest=None)
    add(session, None, variable="salinity", latest=None)

    before = client.get("/healthz")

    assert before.status_code == 503
    assert before.json()["oldest_sync"] is None
    assert before.json()["never_synced"] == ["A01 1 m salinity (buoy)", "A01 1 m temperature (buoy)"]

    add(session, 0.1, "B01", 1)
    add(session, None, source="satellite", latest=None)

    after = client.get("/healthz")

    assert after.status_code == 200
    assert after.json()["never_synced"] == [
        "A01 1 m salinity (buoy)",
        "A01 1 m temperature (buoy)",
        "A01 0 m temperature (satellite)",
    ]
    assert after.json()["stale"] == []
