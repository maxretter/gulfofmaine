"""The summaries every page refetches as readings come in, over a varied record built once for the module.

Each is held to the series-by-series reading of the same record: each
series' days whole, from queries.daily, its months by resampling, and each
heatwave's days spelled out by pandas.
"""

import datetime as dt
from collections import defaultdict

import numpy as np
import pandas as pd
import pytest
from sqlalchemy import event, insert, select
from sqlalchemy.orm import Session

from heatwaves import compare, queries
from heatwaves.compare import OUTCOMES
from heatwaves.models import Buoy, ClimatologyDay, DailyMean, Event, Series
from heatwaves.stations import SourceName, buoy_series
from heatwaves.sync import update_heatwaves
from tests.conftest import TODAY, add_series, api_client, fresh_database


def wandering(start: str, end: str | dt.date, seed: int, gaps: float = 0.0) -> pd.Series:
    """Daily temperatures: a seasonal cycle plus noise that wanders, so that warm spells last.

    None on a fraction `gaps` of the days, at random.
    """
    days = pd.date_range(start, end, freq="D")
    rng = np.random.default_rng(seed)
    shocks = rng.normal(0, 0.4, len(days))
    noise = np.zeros(len(days))
    for i in range(1, len(days)):
        noise[i] = 0.9 * noise[i - 1] + shocks[i]
    cycle = 10 + 6 * np.sin(2 * np.pi * (days.dayofyear.to_numpy() - 120) / 365.25)
    values = pd.Series(cycle + noise, index=days)
    return values[rng.random(len(days)) >= gaps]


@pytest.fixture(scope="module")
def database():
    """At 1 m: A01 from 2003, a tenth of its days missing at random and the spring of 2015 gone;
    B01 from June 2003 until October 2021; E01 since 2019, too short a record for a normal;
    F01 with a normal set by hand and no data. A01 at 20 m too, and the satellite over A01,
    B01 and E01. Each has heatwaves where its noise runs warm.
    """
    a01 = wandering("2003-01-01", TODAY, seed=0, gaps=0.1)
    a01 = a01.drop(a01["2015-03-10":"2015-06-20"].index)
    with fresh_database() as session_factory, session_factory() as session:
        for values, buoy_id, depth, source in (
            (a01, "A01", 1, SourceName.BUOY),
            (wandering("2003-06-01", "2021-10-10", seed=1, gaps=0.05), "B01", 1, SourceName.BUOY),
            (wandering("2019-03-01", TODAY, seed=2), "E01", 1, SourceName.BUOY),
            (wandering("2003-01-01", TODAY, seed=3), "A01", 20, SourceName.BUOY),
            (wandering("2003-01-01", TODAY - dt.timedelta(days=1), seed=4), "A01", 0, SourceName.SATELLITE),
            (wandering("2003-01-01", TODAY - dt.timedelta(days=1), seed=5), "B01", 0, SourceName.SATELLITE),
            (wandering("2003-01-01", TODAY - dt.timedelta(days=1), seed=6), "E01", 0, SourceName.SATELLITE),
        ):
            update_heatwaves(session, add_series(session, values, buoy_id, depth, source=source))
        session.add(Buoy(id="F01", name="Test Buoy", latitude=44.0, longitude=-69.0))
        spec = buoy_series("F01", 1)
        f01 = Series(
            buoy_id=spec.buoy,
            depth=spec.depth,
            variable=spec.variable,
            source=spec.source,
            dataset_id=spec.dataset_id,
        )
        session.add(f01)
        session.flush()
        session.execute(
            insert(ClimatologyDay),
            [
                {"series_id": f01.id, "day_of_year": day, "mean": 10.0, "threshold": 11.0}
                for day in range(1, 367)
            ],
        )
        session.commit()
        yield session_factory


@pytest.fixture(scope="module")
def client(database):
    with api_client(database) as client:
        yield client


def resampled(anomalies: list[pd.Series], min_days: int = 15) -> pd.DataFrame:
    """queries.monthly_anomaly as it was written first: each series' months by resampling."""
    means = []
    for daily_anomaly in anomalies:
        months = daily_anomaly.dropna().resample("MS")
        means.append(months.mean()[months.count() >= min_days])
    if not means:
        return pd.DataFrame({"anomaly": [], "series": []}, index=pd.DatetimeIndex([], name="month"))
    table = pd.concat(means, axis=1)
    frame = pd.DataFrame({"anomaly": table.mean(axis=1), "series": table.count(axis=1)})
    frame.index.name = "month"
    return frame[frame["series"] > 0].sort_index()


def test_anomalies_leave_out_a_series_without_a_normal(database):
    with database() as session:
        ids = {each.buoy_id: each.id for each in queries.buoy_temperatures(session, 1)}
        found = queries.anomalies(session, ids.values())

    assert set(found) == {ids["A01"], ids["B01"], ids["F01"]}  # E01 has no normal
    assert found[ids["F01"]].empty


@pytest.mark.parametrize("depth", [1, 20])
def test_stripes_are_each_series_months_from_its_daily_anomalies(client, database, depth):
    with database() as session:
        frames = [queries.daily(session, each.id) for each in queries.buoy_temperatures(session, depth)]
        months = resampled([frame["anomaly"] for frame in frames if frame is not None])

    assert client.get(f"/api/stripes?depth={depth}").json() == [
        {"month": month.date().isoformat(), "anomaly": round(anomaly, 3), "buoys": int(count)}
        for month, anomaly, count in zip(
            pd.DatetimeIndex(months.index), months["anomaly"], months["series"], strict=True
        )
    ]


def test_anomalies_are_those_of_daily_on_the_days_with_a_value(database):
    with database() as session:
        ids = list(session.scalars(select(Series.id)))
        found = queries.anomalies(session, ids)
        for series_id in ids:
            frame = queries.daily(session, series_id)
            if frame is None:
                assert series_id not in found
                continue
            expected = frame["anomaly"].dropna()
            assert list(found[series_id].index) == list(expected.index)
            assert found[series_id].to_numpy().tobytes() == expected.to_numpy().tobytes()


def test_stripes_read_the_days_of_every_series_at_once(client, database):
    # Two queries for each series' whole record took twice as long.
    engine = database.kw["bind"]
    statements: list[str] = []

    def record(connection, cursor, statement, *args):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        assert client.get("/api/stripes?depth=1").status_code == 200
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert sum("FROM daily_mean" in statement for statement in statements) == 1


def test_monthly_anomaly_groups_as_resampling_by_month():
    rng = np.random.default_rng(0)
    for _ in range(40):
        anomalies = []
        for _ in range(rng.integers(0, 6)):
            start = pd.Timestamp("2001-01-01") + pd.Timedelta(days=int(rng.integers(0, 6000)))
            days = pd.date_range(start, periods=int(rng.integers(0, 2000)), name="date")
            values = rng.normal(0, rng.choice([0.01, 1.0, 1e3]), len(days))
            values[rng.random(len(days)) < rng.choice([0.0, 0.3])] = np.nan
            keep = rng.random(len(days)) >= rng.choice([0.0, 0.5])
            anomalies.append(pd.Series(values[keep], index=days[keep].as_unit(rng.choice(["s", "ns"]))))
        min_days = int(rng.choice([1, 15]))

        old, new = resampled(anomalies, min_days), queries.monthly_anomaly(anomalies, min_days)
        pd.testing.assert_frame_equal(new, old, check_freq=False)
        assert new["anomaly"].to_numpy().tobytes() == old["anomaly"].to_numpy().tobytes()


def observed(session: Session, series_id: int) -> pd.DatetimeIndex:
    """Every day a series has a daily value for."""
    days = session.scalars(select(DailyMean.date).where(DailyMean.series_id == series_id))
    return pd.DatetimeIndex(sorted(days), name="date")


def spelled_out(
    session: Session, series_ids: list[int], start: dt.date | None = None, end: dt.date | None = None
) -> dict[int, pd.Series]:
    """queries.heatwave_days as it was written first: each heatwave's days spelled out by pandas."""
    query = select(Event.series_id, Event.start_date, Event.end_date, Event.category).where(
        Event.series_id.in_(series_ids)
    )
    if start is not None:
        query = query.where(Event.end_date >= start)
    if end is not None:
        query = query.where(Event.start_date <= end)
    spans: dict[int, list[pd.Series]] = defaultdict(list)
    for series_id, first, last, category in session.execute(query):
        spans[series_id].append(pd.Series(category, index=pd.date_range(first, last, name="date")))
    none = pd.Series([], index=pd.DatetimeIndex([], name="date"), dtype=int)
    return {each: pd.concat(spans[each]).sort_index() if spans[each] else none for each in series_ids}


@pytest.mark.parametrize("depth", [1, 20])
def test_agreement_compares_each_series_days_with_the_satellite_above(client, database, depth):
    with database() as session:
        satellites = queries.satellite_temperatures(session)
        pairs = [
            (each, satellites[each.buoy_id])
            for each in queries.buoy_temperatures(session, depth)
            if each.buoy_id in satellites
        ]
        heatwaves = spelled_out(session, [each.id for pair in pairs for each in pair])
        expected = []
        for at_depth, above in pairs:
            table = compare.agreement(
                compare.in_heatwave(observed(session, at_depth.id), heatwaves[at_depth.id]),
                compare.in_heatwave(observed(session, above.id), heatwaves[above.id]),
            )
            expected += [
                {"buoy_id": at_depth.buoy_id, "depth": depth, "year": row.Index}
                | {outcome: getattr(row, outcome) for outcome in OUTCOMES}
                for row in table.itertuples()
            ]

    assert client.get(f"/api/agreement?depth={depth}").json() == expected
    # Every outcome comes up; E01, without a normal at 1 m, has no heatwaves there to agree with.
    assert all(sum(row[outcome] for row in expected) > 0 for outcome in OUTCOMES)
    assert {row["buoy_id"] for row in expected} == ({"A01", "B01", "E01"} if depth == 1 else {"A01"})


def test_common_days_are_the_days_both_series_have_a_value_for(database):
    with database() as session:
        ids = {(each.buoy_id, each.depth, each.source): each.id for each in session.scalars(select(Series))}
        pairs = [
            (ids["A01", 1, SourceName.BUOY], ids["A01", 0, SourceName.SATELLITE]),
            (ids["B01", 1, SourceName.BUOY], ids["A01", 1, SourceName.BUOY]),  # without A01's spring of 2015
            (ids["E01", 1, SourceName.BUOY], ids["F01", 1, SourceName.BUOY]),  # F01 has no data
        ]
        found = queries.common_days(session, pairs)

        assert list(found) == pairs
        for first, second in pairs:
            both = observed(session, first).intersection(observed(session, second))
            assert list(found[first, second]) == list(both)
        assert found[pairs[2]].empty


@pytest.mark.parametrize(
    "start, end", [(None, None), (dt.date(2012, 1, 1), dt.date(2012, 12, 31)), (dt.date(2021, 7, 1), None)]
)
def test_heatwave_days_are_every_day_of_each_heatwave(database, start, end):
    with database() as session:
        ids = list(session.scalars(select(Series.id)))
        found = queries.heatwave_days(session, ids, start, end)
        expected = spelled_out(session, ids, start, end)

    assert found.keys() == expected.keys()
    for series_id in ids:
        pd.testing.assert_series_equal(found[series_id], expected[series_id], check_freq=False)
