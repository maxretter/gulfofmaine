import datetime as dt
import os

# Keep imports of heatwaves.db from pointing at a real database file.
os.environ.setdefault("DATABASE_URL", "sqlite://")

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, insert
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from heatwaves.db import get_session
from heatwaves.main import app
from heatwaves.models import Base, Buoy, DailyMean, Series


@pytest.fixture
def session_factory():
    """A fresh schema per test: in-memory SQLite, or TEST_DATABASE_URL (CI uses Postgres)."""
    url = os.environ.get("TEST_DATABASE_URL", "sqlite://")
    if url.startswith("sqlite"):
        engine = create_engine(url, poolclass=StaticPool, connect_args={"check_same_thread": False})
    else:
        engine = create_engine(url)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield sessionmaker(engine, expire_on_commit=False)
    Base.metadata.drop_all(engine)
    engine.dispose()


@pytest.fixture
def session(session_factory):
    with session_factory() as session:
        yield session


@pytest.fixture
def client(session_factory):
    def override():
        with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override
    yield TestClient(app)
    app.dependency_overrides.clear()


def seasonal_temperatures(start: str, end: str | dt.date, noise: float = 0.5, seed: int = 0) -> pd.Series:
    """Synthetic daily temperatures: a seasonal cycle plus Gaussian noise."""
    days = pd.date_range(start, end, freq="D")
    cycle = 10 + 6 * np.sin(2 * np.pi * (days.dayofyear.to_numpy() - 120) / 365.25)
    return pd.Series(cycle + np.random.default_rng(seed).normal(0, noise, len(days)), index=days)


def add_series(session, temperatures: pd.Series, buoy_id: str = "A01", depth: int = 1) -> Series:
    """A buoy and series holding `temperatures` as its daily means."""
    if session.get(Buoy, buoy_id) is None:
        session.add(Buoy(id=buoy_id, name="Test Buoy", latitude=42.5, longitude=-70.5))
    series = Series(buoy_id=buoy_id, depth=depth, dataset_id=f"{buoy_id}_ocean_{depth:03d}m")
    session.add(series)
    session.flush()
    session.execute(
        insert(DailyMean),
        [
            {"series_id": series.id, "date": day.date(), "temperature": float(value), "hours": 24}
            for day, value in temperatures.dropna().items()
        ],
    )
    session.commit()
    return series
