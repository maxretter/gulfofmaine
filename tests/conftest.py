import datetime as dt
import os
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import unquote

# Keep imports of heatwaves.db from pointing at a real database file.
os.environ.setdefault("DATABASE_URL", "sqlite://")

import httpx
import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, insert
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from heatwaves.db import get_session
from heatwaves.erddap import Erddap
from heatwaves.main import app
from heatwaves.models import Base, Buoy, DailyMean, Series

DATA = Path(__file__).parent / "data"

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
    """The app, reading from `session_factory`'s database."""

    def override():
        with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


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
    series = Series(
        buoy_id=buoy_id,
        depth=depth,
        variable=variable,
        source=source,
        dataset_id=f"{buoy_id}_ocean_{depth:03d}m",
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
