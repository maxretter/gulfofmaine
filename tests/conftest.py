import datetime as dt
import os
import tempfile
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import unquote

# Keep imports of heatwaves.db from pointing at a real database file, and
# anything that writes the products from writing them into the repository.
os.environ.setdefault("DATABASE_URL", "sqlite://")
os.environ.setdefault("PRODUCTS_DIR", tempfile.mkdtemp(prefix="gom-heatwaves-products-"))

import httpx
import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, insert
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from heatwaves import api, db, sync
from heatwaves.erddap import Erddap
from heatwaves.main import app
from heatwaves.models import Base, Buoy, DailyMean, Series
from heatwaves.stations import buoy_series, satellite_series

DATA = Path(__file__).parent / "data"

# "Now" for the tests whose data runs up to today: fixed, with the API's and the
# sync's clocks stopped at it (stopped_clock), so none depends on when, or how
# slowly, it runs.
NOW = dt.datetime(2026, 9, 28, 18, tzinfo=dt.UTC)
TODAY = NOW.date()

# ERDDAP's answer when nothing matches a request; served as a 404, as ERDDAP does.
NO_MATCH = "no_match.txt"

# Recorded from data.neracoos.org on 2026-09-28: a sync of A01_ocean_001m
# from a high-water mark of 2026-09-26T12:00Z.
A01_SYNC = [
    ('orderByMax("time_modified")', "newest.json"),
    ('orderByMinMax("time")', "span.json"),
    ("/A01_ocean_001m.nc?", "A01_ocean_001m.nc"),
]

# The buoy positions ensure_catalog reads, recorded 2026-09-28.
CATALOG = [("/allDatasets.json?", "all_datasets.json")]

# The same days with temperature and salinity, recorded 2026-09-28 up to the
# end of the recorded span (15:00Z), so the sync fetches both at once.
A01_SYNC_WITH_SALINITY = [*A01_SYNC[:2], ("/A01_ocean_001m.nc?", "A01_ocean_001m_salinity.nc")]

# Recorded from coastwatch.pfeg.noaa.gov on 2026-09-28, when the final OISST
# ran through Sep 13 and the preliminary through Sep 27: choosing each buoy's
# cell, then every cell from Aug 27, the final product's days first.
COASTWATCH = "https://coastwatch.pfeg.noaa.gov/erddap"
OISST_SYNC = [
    ("/ncdcOisst21NrtAgg_LonPM180.json?time[last]", "oisst_preliminary_last.json"),
    ("/ncdcOisst21Agg_LonPM180.json?time[last]", "oisst_final_last.json"),
    ("/ncdcOisst21Agg_LonPM180.nc?sst[(2026-09-13T12:00:00Z)]", "oisst_cells.nc"),
    ("/ncdcOisst21Agg_LonPM180.nc?sst[(2026-08-27T12:00:00Z):(2026-09-13T12:00:00Z)]", "oisst_final.nc"),
    (
        "/ncdcOisst21NrtAgg_LonPM180.nc?sst[(2026-09-14T12:00:00Z):(2026-09-27T12:00:00Z)]",
        "oisst_preliminary.nc",
    ),
]


@contextmanager
def fresh_database() -> Iterator[sessionmaker]:
    """An empty schema: in-memory SQLite, or TEST_DATABASE_URL (CI uses Postgres)."""
    url = os.environ.get("TEST_DATABASE_URL", "sqlite://")
    if url.startswith("sqlite"):
        engine = create_engine(url, poolclass=StaticPool, connect_args={"check_same_thread": False})
    else:
        engine = create_engine(url)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    try:
        yield sessionmaker(engine, expire_on_commit=False)
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


@contextmanager
def api_client(session_factory: sessionmaker) -> Iterator[TestClient]:
    """The app, reading from `session_factory`'s database as it reads its own (db.reading).

    On Postgres, then, each request reads one snapshot and can't write, as in production.
    """
    requests = sessionmaker(db.reading(session_factory.kw["bind"]), expire_on_commit=False)

    def override():
        with requests() as session:
            yield session

    app.dependency_overrides[db.get_session] = override
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


@contextmanager
def clock_stopped_at(now: dt.datetime = NOW) -> Iterator[dt.datetime]:
    """The API's clock (api.now, and so api.today) and the sync's (sync.now) stopped at `now`."""
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(api, "now", lambda: now)
        patch.setattr(sync, "now", lambda: now)
        yield now


@pytest.fixture
def stopped_clock() -> Iterator[dt.datetime]:
    """NOW, where the API's and the sync's clocks stay for the test."""
    with clock_stopped_at() as now:
        yield now


@pytest.fixture
def session_factory():
    """A fresh database per test."""
    with fresh_database() as session_factory:
        yield session_factory


@pytest.fixture
def session(session_factory):
    with session_factory() as session:
        yield session


@pytest.fixture
def client(session_factory):
    with api_client(session_factory) as client:
        yield client


def seasonal_temperatures(start: str, end: str | dt.date, noise: float = 0.5, seed: int = 0) -> pd.Series:
    """Synthetic daily temperatures: a seasonal cycle plus Gaussian noise."""
    days = pd.date_range(start, end, freq="D")
    cycle = 10 + 6 * np.sin(2 * np.pi * (days.dayofyear.to_numpy() - 120) / 365.25)
    return pd.Series(cycle + np.random.default_rng(seed).normal(0, noise, len(days)), index=days)


def add_series(
    session,
    values: pd.Series,
    buoy_id: str = "A01",
    depth: int = 1,
    variable: str = "temperature",
    source: str = "buoy",
) -> Series:
    """A buoy and series holding `values` as its daily means."""
    if session.get(Buoy, buoy_id) is None:
        session.add(Buoy(id=buoy_id, name="Test Buoy", latitude=42.5, longitude=-70.5))
    spec = satellite_series(buoy_id) if source == "satellite" else buoy_series(buoy_id, depth, variable)
    series = Series(
        buoy_id=buoy_id,
        depth=spec.depth,
        variable=spec.variable,
        source=spec.source,
        dataset_id=spec.dataset_id,
    )
    session.add(series)
    session.flush()
    observed = values.dropna()
    session.execute(
        insert(DailyMean),
        [
            {"series_id": series.id, "date": day, "value": float(value), "hours": 24}
            for day, value in zip(pd.DatetimeIndex(observed.index).date, observed, strict=True)
        ],
    )
    session.commit()
    return series


def recorded_erddap(
    responses: Sequence[tuple[str, str]],
    requests: list[str],
    base_url: str = "https://data.neracoos.org/erddap",
) -> Erddap:
    """An ERDDAP client answered from files in tests/data, with no network.

    Each request gets the file of the first (pattern, file) pair whose pattern
    is in its decoded URL, or a 500 if none is. Every URL requested is
    appended to `requests`.
    """

    def respond(request: httpx.Request) -> httpx.Response:
        url = unquote(str(request.url))
        requests.append(url)
        for pattern, name in responses:
            if pattern in url:
                return httpx.Response(404 if name == NO_MATCH else 200, content=(DATA / name).read_bytes())
        return httpx.Response(500)

    return Erddap(base_url, httpx.Client(transport=httpx.MockTransport(respond)))
