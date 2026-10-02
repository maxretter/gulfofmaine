"""The sync against recorded ERDDAP responses (see tests/conftest.py)."""

import datetime as dt
import json
import operator
import os
import re
import threading
from collections.abc import Callable, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from time import monotonic, sleep

import httpx
import numpy as np
import pandas as pd
import pytest
import xarray as xr
from sqlalchemy import delete, event, select, text, update
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session, sessionmaker

from heatwaves import hobday, live, origin, queries, sync
from heatwaves.config import settings
from heatwaves.erddap import Erddap, format_time, parse_time
from heatwaves.models import Buoy, ClimatologyDay, DailyMean, Event, Series
from heatwaves.sources import Download, GriddapSource, TabledapSource
from heatwaves.stations import OISST, OISST_PRELIMINARY, SERIES
from heatwaves.sync import ensure_catalog, publish, sync_all, sync_one, sync_series
from tests.conftest import (
    A01_SYNC,
    A01_SYNC_WITH_SALINITY,
    CATALOG,
    COASTWATCH,
    DATA,
    NO_MATCH,
    OISST_SYNC,
    add_series,
    recorded_erddap,
    seasonal_temperatures,
)

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "sqlite://")
postgres_only = pytest.mark.skipif(
    not TEST_DATABASE_URL.startswith("postgresql"), reason="the sync's lock is Postgres's (TEST_DATABASE_URL)"
)


def buoy_sources(erddap):
    return {"buoy": TabledapSource(erddap)}


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

    assert sync_series(session, buoy_sources(recorded_erddap(A01_SYNC, requests)), series)

    newest, stamped_since, overlap, data = requests
    # Two days of overlap behind the stored high-water mark...
    assert "time_modified>2026-09-24T12:00:00Z" in newest
    # ...for the span of the rows stamped since the mark, and of those stamped and observed in the overlap...
    assert "time_modified<=2026-09-28T16:32:11Z&time_modified>2026-09-26T12:00:00Z" in stamped_since
    assert "time_modified<=2026-09-28T16:32:11Z&time>2026-09-24T12:00:00Z" in overlap
    # ...then whole days, covering every row that changed.
    assert data.startswith("https://data.neracoos.org/erddap/tabledap/A01_ocean_001m.nc?time,temperature,")
    assert "time>=2026-09-24T00:00:00Z&time<2026-09-29T00:00:00Z" in data

    daily = dict(session.execute(select(DailyMean.date, DailyMean.value)).all())
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

    assert not sync_series(session, buoy_sources(recorded_erddap([("", NO_MATCH)], requests)), series)

    assert len(requests) == 1
    assert series.synced_at is not None
    assert series.modified_through == dt.datetime(2026, 9, 26, 12, tzinfo=dt.UTC)
    assert session.scalars(select(Event)).all() == events_before


def test_sync_fetches_every_variable_of_a_dataset_at_once(session, series):
    salinity = add_series(
        session, pd.Series(31.0, index=pd.date_range("2026-09-01", "2026-09-27")), variable="salinity"
    )
    salinity.modified_through = series.modified_through
    session.commit()
    requests: list[str] = []

    assert sync_series(session, buoy_sources(recorded_erddap(A01_SYNC_WITH_SALINITY, requests)), salinity)

    *_, data = requests
    assert "?time,temperature,temperature_qc,temperature_qc_agg,salinity,salinity_qc,salinity_qc_agg&" in data
    for each, low, high in ((series, 14, 17), (salinity, 31, 32)):
        values = session.scalars(
            select(DailyMean.value).where(
                DailyMean.series_id == each.id, DailyMean.date >= dt.date(2026, 9, 24)
            )
        ).all()
        assert len(values) == 4
        assert all(low < value < high for value in values)
        assert each.modified_through == dt.datetime(2026, 9, 28, 16, 32, 11, tzinfo=dt.UTC)


def test_sync_stops_after_one_request_when_the_newest_stamp_was_already_read(session, series):
    series.modified_through = dt.datetime(2026, 9, 28, 16, 32, 11, tzinfo=dt.UTC)  # as in newest.json
    requests: list[str] = []

    assert not sync_series(session, buoy_sources(recorded_erddap(A01_SYNC, requests)), series)

    assert len(requests) == 1


def test_sync_clears_days_whose_rows_are_gone(session, series):
    # ERDDAP stamped changes to these days, but no rows remain in them.
    series.latest_reading_at, series.latest_reading = dt.datetime(2026, 9, 27, 12, tzinfo=dt.UTC), 15.0
    requests: list[str] = []
    gone = [*A01_SYNC[:2], ("/A01_ocean_001m.nc?", NO_MATCH)]

    assert sync_series(session, buoy_sources(recorded_erddap(gone, requests)), series)

    days = session.scalars(select(DailyMean.date).where(DailyMean.date >= dt.date(2026, 9, 20))).all()
    assert days == [dt.date(2026, 9, day) for day in (20, 21, 22, 23)]
    assert series.modified_through == dt.datetime(2026, 9, 28, 16, 32, 11, tzinfo=dt.UTC)
    assert (series.latest_reading_at, series.latest_reading) == (None, None)  # its row is gone too


def test_a_reading_failed_since_gives_way_to_the_newest_good_one(monkeypatch, session, series):
    # Stored by an earlier sync, then failed by quality control: the recorded download has no such reading.
    spike = dt.datetime(2026, 9, 28, 16, 30, tzinfo=dt.UTC)
    series.latest_reading_at, series.latest_reading = spike, 30.0
    published: list[live.Message] = []
    monkeypatch.setattr(sync.live, "publish", lambda session, messages: published.extend(messages))

    assert sync_series(session, buoy_sources(recorded_erddap(A01_SYNC, [])), series)

    assert (series.latest_reading_at, series.latest_reading) == (spike - dt.timedelta(minutes=30), 15.11)
    # Older than the one pages were sent, so not announced as a new reading.
    assert not [message for message in published if isinstance(message, live.ReadingMessage)]


COMPARE = {">": operator.gt, ">=": operator.ge, "<": operator.lt, "<=": operator.le}


class StampedErddap(Erddap):
    """A buoy dataset answered as ERDDAP would: rows observed hourly, each with its time_modified stamp."""

    def __init__(self, first: dt.datetime, last: dt.datetime) -> None:
        super().__init__("https://data.neracoos.org/erddap", httpx.Client())
        hours = pd.date_range(first, last, freq="h").to_pydatetime()
        self.stamps = {time: time + dt.timedelta(minutes=30) for time in hours}  # by observation time
        self.downloads: list[tuple[dt.date, dt.date]] = []

    def matching(self, constraints: Sequence[str]) -> list[dt.datetime]:
        """The observation times of the rows that meet every constraint."""
        times = sorted(self.stamps)
        for constraint in constraints:
            match = re.fullmatch(r"(time|time_modified)(>=|<=|>|<)(.+)", constraint)
            assert match is not None, constraint
            name, op, value = match.groups()
            column = self.stamps if name == "time_modified" else {t: t for t in times}
            times = [t for t in times if COMPARE[op](column[t], parse_time(value))]
        return times

    def rows(self, dataset_id: str, variables: Sequence[str], constraints: Sequence[str] = ()) -> list[dict]:
        times = self.matching([c for c in constraints if not c.startswith("orderBy")])
        if not times:
            return []
        if 'orderByMax("time_modified")' in constraints:
            return [{"time_modified": format_time(max(self.stamps[t] for t in times))}]
        return [{"time": format_time(times[0])}, {"time": format_time(times[-1])}]

    def dataset(
        self, dataset_id: str, variables: Sequence[str], constraints: Sequence[str] = ()
    ) -> xr.Dataset:
        times = pd.DatetimeIndex(self.matching(constraints)).tz_localize(None)
        self.downloads.append((times[0].date(), times[-1].date()))
        columns = {"temperature": 15.0, "temperature_qc": 0, "temperature_qc_agg": 1}  # good readings
        return xr.Dataset(
            {"time": ("row", times)}
            | {name: ("row", np.full(len(times), value)) for name, value in columns.items()}
        )


def test_a_reprocessing_is_downloaded_once():
    mark = dt.datetime(2026, 9, 1, tzinfo=dt.UTC)
    erddap = StampedErddap(dt.datetime(2026, 6, 1, tzinfo=dt.UTC), mark - dt.timedelta(minutes=30))
    series = Series(id=1, dataset_id="A01_ocean_001m", variable="temperature", modified_through=mark)
    source = TabledapSource(erddap)
    # UMaine replaces June and July with post-recovery data.
    for time in erddap.stamps:
        if time < dt.datetime(2026, 8, 1, tzinfo=dt.UTC):
            erddap.stamps[time] = mark + dt.timedelta(minutes=10)

    # Then the buoy reports hourly for three days, and the sync checks each hour.
    for hour in range(72):
        time = mark + dt.timedelta(hours=hour)
        erddap.stamps[time] = time + dt.timedelta(minutes=30)
        download = source.fetch([series])
        assert download is not None
        series.modified_through = download.modified_through

    reprocessed, *rest = erddap.downloads
    assert reprocessed == (dt.date(2026, 6, 1), dt.date(2026, 9, 1))
    # After that, only the days of the overlap, as on any other hour.
    assert all(first >= dt.date(2026, 8, 30) for first, _ in rest)


def test_a_row_that_reaches_erddap_late_is_still_read():
    mark = dt.datetime(2026, 9, 1, tzinfo=dt.UTC)
    erddap = StampedErddap(dt.datetime(2026, 8, 1, tzinfo=dt.UTC), mark - dt.timedelta(minutes=30))
    series = Series(id=1, dataset_id="A01_ocean_001m", variable="temperature", modified_through=mark)
    # The buoy was quiet from Aug 30 to midday on Aug 31, but for one reading: stamped before the
    # sync read up to the mark, it reaches ERDDAP after.
    quiet = (dt.datetime(2026, 8, 30, tzinfo=dt.UTC), dt.datetime(2026, 8, 31, 12, tzinfo=dt.UTC))
    erddap.stamps = {time: stamp for time, stamp in erddap.stamps.items() if not quiet[0] <= time < quiet[1]}
    late = dt.datetime(2026, 8, 30, 12, tzinfo=dt.UTC)
    erddap.stamps[late] = late + dt.timedelta(minutes=30)
    erddap.stamps[mark] = mark + dt.timedelta(minutes=30)

    assert TabledapSource(erddap).fetch([series])

    assert erddap.downloads == [(late.date(), mark.date())]


def test_catalog_adds_each_series_once_with_its_buoy_position(session):
    requests: list[str] = []
    erddap = recorded_erddap(CATALOG, requests)

    ensure_catalog(session, erddap)
    ensure_catalog(session, erddap)

    # Temperature and salinity at 25 buoy depths, and 6 satellite cells.
    assert len(session.scalars(select(Series)).all()) == len(SERIES) == 2 * 25 + 6
    a01 = session.get_one(Buoy, "A01")
    assert (a01.name, a01.latitude, a01.longitude) == ("Massachusetts Bay", 42.5183, -70.5681)
    # Positions come from each buoy's shallowest dataset.
    assert 'datasetID=~"^(A01_ocean_001m|B01_ocean_001m|E01_ocean_001m|' in requests[0]
    assert session.get_one(Buoy, "N01").latitude == 42.3207


def test_a_failing_dataset_doesnt_stop_the_others(session_factory):
    # A01's datasets have nothing new; every other buoy dataset answers with
    # an error, and there's no source for the satellite dataset at all.
    erddap = recorded_erddap([*CATALOG, ("/A01_", NO_MATCH)], [])

    assert sync_all(session_factory, erddap, buoy_sources(erddap)) == 22 + 1

    with session_factory() as session:
        synced = session.scalars(select(Series.dataset_id).where(Series.synced_at.is_not(None))).all()
    # Temperature and salinity from each of A01's datasets.
    assert sorted(synced) == sorted(["A01_ocean_001m", "A01_ocean_020m", "A01_ocean_050m"] * 2)


def test_sync_one_says_what_the_fetch_came_to(session_factory, series):
    for responses, outcome in ((A01_SYNC, "updated"), ([("", NO_MATCH)], "unchanged"), ([], "failed")):
        assert sync_one(session_factory, buoy_sources(recorded_erddap(responses, [])), series.id) == outcome


def test_a_round_rewrites_the_products_when_it_stores_data(monkeypatch, session_factory, session, tmp_path):
    add_series(session, seasonal_temperatures("2020-01-01", "2020-12-31"))
    erddap = recorded_erddap(CATALOG, [])
    csv = tmp_path / "daily" / "A01_heatwaves_001m.csv"

    def round_of(*outcomes):
        """A round in which the fetches come to these outcomes, in turn."""
        each = iter(outcomes * len(SERIES))
        monkeypatch.setattr(sync, "sync_one", lambda *args: next(each))
        return sync_all(session_factory, erddap, {}, products_dir=tmp_path)

    # Nothing new, but no files yet either, as on a fresh volume: they're written.
    assert round_of("unchanged") == 0
    assert sorted(path.name for path in tmp_path.rglob("*.*")) == [csv.name, "A01_heatwaves_001m.nc"]
    # A year is too short a record for a normal, so no heatwaves either: the values alone.
    ds = xr.load_dataset(csv.with_suffix(".nc"))
    assert ds.temperature.notnull().all() and ds.temperature_climatology.isnull().all()
    # Nothing new: the files stay as they are.
    csv.unlink()
    round_of("unchanged")
    assert not csv.exists()
    # Something new: they're rewritten, even when other fetches failed.
    assert round_of("failed", "updated") > 0
    assert csv.exists()


class NewDays:
    """A source with new days for the datasets in `new`, by dataset ID, and nothing new for the rest."""

    def __init__(self) -> None:
        self.new: dict[str, pd.Series] = {}

    def fetch(self, series: Sequence[Series]) -> Download | None:
        values = self.new.pop(series[0].dataset_id, None)
        if values is None:
            return None
        days = pd.DatetimeIndex(values.index, name="date")
        frame = pd.DataFrame({"value": values.to_numpy(), "hours": 24}, index=days)
        stamp = dt.datetime(2026, 9, 28, tzinfo=dt.UTC)
        return Download(days[0].date(), days[-1].date(), {each.id: frame for each in series}, stamp)

    def page_url(self, series: Series) -> str:
        return ""


def test_a_round_rewrites_the_files_of_each_buoy_depth_it_changed(monkeypatch, session_factory, tmp_path):
    days = pd.date_range("2025-01-01", "2025-06-30")
    with session_factory() as session:
        for buoy_id, depth, source in (
            ("A01", 1, "buoy"),
            ("A01", 50, "buoy"),
            ("B01", 20, "buoy"),
            ("A01", 0, "satellite"),
        ):
            add_series(session, pd.Series(10.0, index=days), buoy_id, depth, source=source)
        # A heatwave at B01 20 m, whose origin nothing at A01 bears on.
        b01 = session.scalars(select(Series).where(Series.buoy_id == "B01")).one()
        start, end = days[10].date(), days[20].date()
        session.add(
            Event(
                series_id=b01.id,
                start_date=start,
                end_date=end,
                peak_date=start,
                max_intensity=2.0,
                mean_intensity=1.0,
                category=1,
                origin="offshore",
            )
        )
        session.commit()
    erddap = recorded_erddap(CATALOG, [])
    source = NewDays()
    june = pd.Series(11.0, index=pd.date_range("2025-06-29", "2025-07-01"))

    def round_of(**new: pd.Series) -> set[str]:
        """The files a round rewrites, in which these datasets have new days."""
        source.new = new
        written = {path.name: path.stat().st_mtime_ns for path in tmp_path.rglob("*.*")}
        sync_all(session_factory, erddap, {"buoy": source, "satellite": source}, products_dir=tmp_path)
        return {
            path.name for path in tmp_path.rglob("*.*") if written.get(path.name) != path.stat().st_mtime_ns
        }

    def files(*names: str) -> set[str]:
        return {f"{name}.{format}" for name in (*names, "gom_heatwaves_events") for format in ("nc", "csv")}

    a01_1, a01_50, b01_20 = "A01_heatwaves_001m", "A01_heatwaves_050m", "B01_heatwaves_020m"
    # Nothing new, but no files yet: every one is written.
    assert round_of() == files(a01_1, a01_50, b01_20)
    assert round_of() == set()
    assert round_of(A01_ocean_050m=june) == files(a01_50)
    # The satellite is in every file at each of its buoys.
    assert round_of(**{OISST: june}) == files(a01_1, a01_50, b01_20)

    # A store at A01 1 m that changes the origin of the heatwave at B01.
    def relabel(session: Session, changed: object) -> None:
        session.execute(update(Event).where(Event.series_id == b01.id).values(origin="surface"))

    with monkeypatch.context() as patched:
        patched.setattr(sync, "update_origins", relabel)
        assert round_of(A01_ocean_001m=june) == files(a01_1, b01_20)

    # The catalog moves a buoy back to where ERDDAP has it.
    with session_factory() as session:
        session.get_one(Buoy, "A01").latitude = 42.0
        session.commit()
    assert round_of() == files(a01_1, a01_50)

    # A write that fails leaves its files to the next round, new data or not.
    def fails(*args: object) -> None:
        raise OSError("No space left on device")

    with monkeypatch.context() as patched:
        patched.setattr(sync.products, "write", fails)
        assert round_of(A01_ocean_050m=june + 1) == set()
    assert round_of() == files(a01_50)

    # A new process writes every file at its first round, as does the round after one that
    # couldn't tell which files it changed.
    del sync._unwritten[tmp_path]
    assert round_of() == files(a01_1, a01_50, b01_20)
    with monkeypatch.context() as patched:
        patched.setattr(sync, "_changed_files", fails)
        with pytest.raises(OSError):
            round_of(A01_ocean_001m=june + 1)
    assert round_of() == files(a01_1, a01_50, b01_20)
    # And the round after one that stored a dataset, then lost its database before the next.
    with monkeypatch.context() as patched:
        each = iter([sync.sync_one, fails])
        patched.setattr(sync, "sync_one", lambda *args: next(each)(*args))
        with pytest.raises(OSError):
            round_of(A01_ocean_001m=june + 2)
    assert round_of() == files(a01_1, a01_50, b01_20)


def test_a_failed_write_leaves_the_sync_alone(session_factory, series, tmp_path, caplog):
    blocked = tmp_path / "products"
    blocked.write_text("not a directory")

    assert not publish(session_factory, blocked)

    assert "Writing the products" in caplog.text


@pytest.mark.parametrize(("failures", "status"), [(0, 0), (2, 1)])
def test_sync_job_exit_status_reports_failures(monkeypatch, session_factory, failures, status):
    monkeypatch.setattr("heatwaves.db.SessionLocal", session_factory)
    monkeypatch.setattr(sync, "sync_all", lambda *args: failures)

    assert sync.main([]) == status


class Stop(Exception):
    """Ends the sync job's loop in a test."""


def test_sync_job_carries_on_after_a_failed_round(monkeypatch, session_factory):
    rounds: list[bool] = []
    errors = [
        httpx.ConnectError("ERDDAP is down"),
        json.JSONDecodeError("Expecting value", "<html>", 0),  # a maintenance page in place of JSON
        OperationalError("SELECT", {}, Exception("the database restarted")),
    ]

    def sync_all(session_factory, erddap, sources, everything, products_dir):
        rounds.append(everything)
        if len(rounds) <= len(errors):
            raise errors[len(rounds) - 1]
        return 0

    def sleep(seconds):
        assert seconds == 600
        if len(rounds) == 4:
            raise Stop

    monkeypatch.setattr("heatwaves.db.SessionLocal", session_factory)
    monkeypatch.setattr(sync, "sync_all", sync_all)
    monkeypatch.setattr(sync.time, "sleep", sleep)

    with pytest.raises(Stop):
        sync.main(["--every", "600"])
    assert rounds == [True, False, False, False]  # a failed full round isn't tried again in full
    # Run once, the job fails instead.
    rounds.clear()
    with pytest.raises(httpx.ConnectError):
        sync.main([])


def test_a_failed_catalog_doesnt_stop_the_round(session_factory):
    with session_factory() as session:
        ensure_catalog(session, recorded_erddap(CATALOG, []))  # an earlier round placed the buoys

    def neracoos(request: httpx.Request) -> httpx.Response:
        # A maintenance page where the catalog's JSON should be; nothing new in any dataset.
        if "/allDatasets." in request.url.path:
            return httpx.Response(200, html="<html><body>Down for maintenance</body></html>")
        return httpx.Response(404, content=(DATA / NO_MATCH).read_bytes())

    erddap = Erddap("https://data.neracoos.org/erddap", httpx.Client(transport=httpx.MockTransport(neracoos)))
    coastwatch = recorded_erddap(OISST_SYNC, [], COASTWATCH)
    sources = {
        "buoy": TabledapSource(erddap),
        "satellite": GriddapSource(coastwatch, OISST, OISST_PRELIMINARY, start=dt.date(2026, 8, 27)),
    }

    assert sync_all(session_factory, erddap, sources) == 1  # the catalog

    with session_factory() as session:
        satellites = session.scalars(select(Series).where(Series.source == "satellite")).all()
        assert {each.modified_through for each in satellites} == {dt.datetime(2026, 9, 27, 12, tzinfo=dt.UTC)}
        assert session.get_one(Buoy, "A01").latitude == 42.5183  # as stored


def test_a_database_error_is_a_failed_fetch(monkeypatch, session_factory, series):
    engine = session_factory.kw["bind"]
    down = False

    def refuse(*args):
        if down:
            raise OperationalError("SELECT", {}, Exception("server closed the connection"))

    def sync_series(session, sources, series):
        nonlocal down
        down = True
        raise OperationalError("UPDATE", {}, Exception("server closed the connection"))

    monkeypatch.setattr(sync, "sync_series", sync_series)
    event.listen(engine, "before_cursor_execute", refuse)
    try:
        assert sync_one(session_factory, {}, series.id) == "failed"
    finally:
        down = False
        event.remove(engine, "before_cursor_execute", refuse)


def test_kept_running_the_job_checks_everything_about_hourly(monkeypatch, session_factory):
    rounds: list[bool] = []

    def sync_all(session_factory, erddap, sources, everything, products_dir):
        rounds.append(everything)
        assert products_dir == settings.products_dir
        return 0

    def sleep(seconds):
        if len(rounds) == 8:
            raise Stop

    monkeypatch.setattr("heatwaves.db.SessionLocal", session_factory)
    monkeypatch.setattr(sync, "sync_all", sync_all)
    monkeypatch.setattr(sync.time, "sleep", sleep)

    with pytest.raises(Stop):
        sync.main(["--every", "600"])

    assert rounds == [True, False, False, False, False, False, True, False]


def test_between_full_rounds_only_the_buoys_still_reporting_are_checked(session_factory):
    today = dt.datetime.now(dt.UTC).date()
    with session_factory() as session:
        reporting = add_series(session, pd.Series([15.0], index=[pd.Timestamp(today)]))
        salinity = add_series(session, pd.Series([31.0], index=[pd.Timestamp(today)]), variable="salinity")
        retired = add_series(session, pd.Series([9.0], index=[pd.Timestamp("2025-09-17")]), "M01", 100)
        satellite = add_series(session, pd.Series([15.5], index=[pd.Timestamp(today)]), source="satellite")
        for each in (reporting, salinity, satellite):
            each.latest_date = today
        retired.latest_date = dt.date(2025, 9, 17)
        session.commit()
    requests: list[str] = []
    erddap = recorded_erddap([("", NO_MATCH)], requests)

    # No satellite source here: syncing the satellite would count as a failure.
    assert sync_all(session_factory, erddap, buoy_sources(erddap), everything=False) == 0

    # One small request for A01's 1 m dataset, both variables at once; no catalog, M01 or satellite.
    [request] = requests
    assert "/tabledap/A01_ocean_001m.json?time_modified" in request


def test_a_series_without_a_normal_is_still_checked_while_it_reports(session_factory):
    today = dt.datetime.now(dt.UTC).date()
    with session_factory() as session:
        # A month of readings: far too few for a normal.
        recent = seasonal_temperatures((today - dt.timedelta(days=30)).isoformat(), today)
        series = add_series(session, recent)

        updated = sync.update_heatwaves(session, series)
        session.commit()

        assert (updated.before.state, updated.after.state) == ("no_data", "no_normal")
        assert (series.latest_date, series.latest_value) == (today, pytest.approx(recent.iloc[-1]))
        assert (series.latest_climatology, series.latest_threshold, series.days_above) == (None, None, 0)
    requests: list[str] = []
    erddap = recorded_erddap([("", NO_MATCH)], requests)

    assert sync_all(session_factory, erddap, buoy_sources(erddap), everything=False) == 0

    [request] = requests
    assert "/tabledap/A01_ocean_001m.json?time_modified" in request


def test_a_series_that_loses_its_normal_loses_its_heatwaves(session):
    temperatures = seasonal_temperatures("2003-01-01", "2026-09-27")
    temperatures.iloc[-8:] += 2.5
    series = add_series(session, temperatures)
    sync.update_heatwaves(session, series)
    assert session.scalars(select(Event)).all()
    # Reprocessed upstream, the baseline years are gone.
    session.execute(delete(DailyMean).where(DailyMean.date < dt.date(2023, 1, 1)))

    sync.update_heatwaves(session, series)

    assert session.scalars(select(Event)).all() == []
    assert session.scalars(select(ClimatologyDay)).all() == []
    assert (series.latest_date, series.latest_climatology) == (dt.date(2026, 9, 27), None)


def download(series: Series, values: pd.Series) -> Download:
    """What a source would return for one series: these daily values."""
    days = pd.DatetimeIndex(values.index, name="date")
    return Download(
        first_day=days[0].date(),
        last_day=days[-1].date(),
        daily={series.id: pd.DataFrame({"value": values.to_numpy(), "hours": 24}, index=days)},
        modified_through=dt.datetime(2026, 9, 28, tzinfo=dt.UTC),
    )


def derived(session: Session) -> list[tuple]:
    """Everything update_heatwaves and update_origins derive from the daily means, but database IDs."""
    queries = [
        select(
            ClimatologyDay.series_id,
            ClimatologyDay.day_of_year,
            ClimatologyDay.mean,
            ClimatologyDay.threshold,
        ),
        select(
            Event.series_id,
            Event.start_date,
            Event.end_date,
            Event.peak_date,
            Event.max_intensity,
            Event.mean_intensity,
            Event.category,
            Event.origin,
            Event.evidence,
        ),
        select(
            Series.id,
            Series.latest_date,
            Series.latest_value,
            Series.latest_climatology,
            Series.latest_threshold,
            Series.days_above,
        ),
    ]
    return [
        tuple(row)
        for query in queries
        for row in session.execute(query.order_by(*query.selected_columns[:2]))
    ]


def test_a_normal_is_computed_again_only_when_a_day_it_comes_from_changes(monkeypatch, session):
    temperatures = seasonal_temperatures("2002-12-01", "2023-06-30")
    temperatures.iloc[-10:] += 2.5
    # A gap at the baseline's start, which interpolation fills from 2002-12-30 and 2003-01-02.
    temperatures = temperatures.drop(pd.date_range("2002-12-31", "2003-01-01"))
    series = add_series(session, temperatures)
    sync.update_heatwaves(session, series)
    computed: list[pd.Series] = []
    climatology = hobday.climatology
    monkeypatch.setattr(
        sync.hobday, "climatology", lambda daily, *args: computed.append(daily) or climatology(daily, *args)
    )

    def recomputed() -> list:
        sync.update_heatwaves(session, series)
        return derived(session)

    # A day too early to fill the gap: the stored normal stands, as it would be computed anew.
    earlier = pd.Timestamp(sync.NORMAL_DAYS[0] - dt.timedelta(days=1))
    sync.store(session, [series], download(series, temperatures[earlier:earlier] + 3))
    assert computed == []
    assert derived(session) == recomputed()

    # The day that fills it: the normal changes.
    before = derived(session)
    computed.clear()
    first = pd.Timestamp(sync.NORMAL_DAYS[0])
    sync.store(session, [series], download(series, temperatures[first:first] + 3))
    assert len(computed) == 1
    after = derived(session)
    assert after != before
    assert after == recomputed()

    # After the baseline, as on every hour.
    computed.clear()
    sync.store(session, [series], download(series, temperatures["2023-06-25":] + 0.5))
    assert computed == []
    assert derived(session) == recomputed()


def test_a_store_judges_again_only_the_origins_its_days_bear_on(monkeypatch, session):
    # As in tests/test_api_origin.py, but in 2025, after the baseline: at A01 50 m a heatwave
    # from Apr 14 that every signal says is offshore, at M01 50 m one from Feb 13, and at M01
    # 100 m one from Mar 20.
    calm = slice("2025-01-01", "2025-05-31")  # noise-free, so each heatwave's edges are exact
    days = pd.date_range("2003-01-01", "2025-06-30")

    def warmed(offset: float, seed: int, heatwave: slice | None = None) -> pd.Series:
        values = seasonal_temperatures("2003-01-01", "2025-06-30", seed=seed) + offset
        values[calm] = seasonal_temperatures("2003-01-01", "2025-06-30", noise=0)[calm] + offset
        if heatwave is not None:
            values[heatwave] += 2.5
        return values

    salinity = pd.Series(32 + np.random.default_rng(9).normal(0, 0.1, len(days)), index=days)
    salinity[calm] = 32.3
    region = {
        ("A01", 50, "temperature"): warmed(0, 0, slice("2025-04-14", "2025-04-28")),
        ("A01", 1, "temperature"): warmed(6, 1),
        ("M01", 50, "temperature"): warmed(0, 2, slice("2025-02-13", "2025-02-22")),
        ("M01", 100, "temperature"): warmed(-3, 3, slice("2025-03-20", "2025-04-05")),
        ("A01", 50, "salinity"): salinity,
    }
    series = {key: add_series(session, values, *key) for key, values in region.items()}
    for each in series.values():
        sync.update_heatwaves(session, each)
    sync.update_origins(session)
    onset = dt.date(2025, 4, 14)
    april = session.scalars(select(Event).where(Event.series_id == series["A01", 50, "temperature"].id)).one()
    judged: list[tuple[str, int, dt.date]] = []
    judge = sync.origin.judge
    monkeypatch.setattr(
        sync.origin, "judge", lambda record, *event: judged.append(event) or judge(record, *event)
    )

    def store(key: tuple[str, int, str], days: slice, change: float) -> list[tuple[str, int, dt.date]]:
        """The heatwaves whose origin storing these days of a series, changed by `change`, judges again."""
        judged.clear()
        sync.store(session, [series[key]], download(series[key], region[key][days] + change))
        return list(judged)

    def judged_afresh() -> bool:
        """Whether every stored origin is as judging it from the whole record finds it."""
        record = queries.origin_record(session)
        events = session.execute(
            select(Event.origin, Event.evidence, Event.start_date, Series.buoy_id, Series.depth)
            .join(Series)
            .where(Series.variable == "temperature", Series.depth.in_(origin.DEPTHS))
        ).all()
        return all(
            event.evidence == judge(record, event.buoy_id, event.depth, event.start_date).to_json()
            and event.origin == event.evidence["origin"]
            for event in events
        )

    assert judged_afresh()
    evidence = [april.evidence]
    for key, days, change in [
        (("A01", 1, "temperature"), slice("2025-03-20", "2025-04-10"), -3.0),  # stratification
        (("M01", 100, "temperature"), slice("2025-03-20", "2025-04-05"), -2.5),  # no heatwave at depth
        (("A01", 50, "salinity"), slice("2025-04-01", "2025-04-20"), -0.3),  # fresher
    ]:
        assert store(key, days, change) == [("A01", 50, onset)]
        session.refresh(april)
        assert april.evidence not in evidence
        evidence.append(april.evidence)
        assert judged_afresh()

    # A new heatwave at A01 50 m gets its origin, though its window runs past the record's
    # end; the April one, unchanged, keeps its row.
    june = ("A01", 50, dt.date(2025, 6, 20))
    assert store(("A01", 50, "temperature"), slice("2025-06-20", None), 2.5) == [june]
    assert judged_afresh()
    assert session.get_one(Event, april.id).evidence == evidence[-1]

    # The first day the April heatwave's origin reads, and the day before.
    first = pd.Timestamp(origin.window(onset)[0])
    assert store(("A01", 1, "temperature"), slice(first, first), 0.1) == [("A01", 50, onset)]
    before = first - pd.Timedelta(days=1)
    assert store(("A01", 1, "temperature"), slice(before, before), 0.1) == []
    assert judged_afresh()


def test_a_window_of_the_origin_record_holds_the_days_the_whole_record_does(session):
    # So a mean over a window adds the same values in the same order: none of the days past
    # where a series' data begin or end, which pairwise summation would group differently.
    for depth, start, end in ((50, "2003-01-01", "2025-06-30"), (1, "2005-01-01", "2025-06-20")):
        sync.update_heatwaves(session, add_series(session, seasonal_temperatures(start, end), "A01", depth))
    whole = queries.origin_record(session)

    for first, last in [
        (dt.date(2025, 6, 1), dt.date(2025, 7, 15)),
        (dt.date(2004, 12, 1), dt.date(2005, 2, 1)),
    ]:
        part = queries.origin_record(session, first, last)
        assert part.temperature.keys() == whole.temperature.keys()
        for key, frame in whole.temperature.items():
            assert part.temperature[key].equals(frame.loc[pd.Timestamp(first) : pd.Timestamp(last)]), key


def test_an_origin_record_around_a_heatwave_holds_every_onset_at_its_depth(session):
    days = pd.date_range("2021-01-01", "2021-06-30")
    heatwaves = {
        "A01": ("2021-04-14", "2021-04-28"),
        "E01": ("2021-03-01", "2021-03-10"),
        "I01": ("2021-01-05", "2021-01-14"),
    }
    for buoy_id, (start, end) in heatwaves.items():
        series = add_series(session, pd.Series(10.0, index=days), buoy_id, 50)
        session.add(
            Event(
                series_id=series.id,
                start_date=dt.date.fromisoformat(start),
                end_date=dt.date.fromisoformat(end),
                peak_date=dt.date.fromisoformat(start),
                max_intensity=2.0,
                mean_intensity=1.0,
                category=1,
            )
        )
    session.commit()
    onset = dt.date(2021, 4, 14)
    first, last = onset - dt.timedelta(days=origin.LOOKBACK), onset + dt.timedelta(days=origin.AFTER)

    # As the event's page reads it: E01 isn't among what judging A01 reads, but its onset is listed.
    record = queries.origin_record(session, first, last, around=[("A01", 50)])
    whole = queries.origin_record(session)
    expected = [("E01", dt.date(2021, 3, 1)), ("A01", onset)]
    assert origin.recent_onsets(record, 50, onset) == origin.recent_onsets(whole, 50, onset) == expected
    # I01's heatwave ends on the first day read, and comes whole, so that day isn't taken for an onset.
    assert record.heatwave_days["I01", 50].index[0] == pd.Timestamp("2021-01-05")


def test_recompute_rebuilds_heatwaves_from_stored_data(monkeypatch, session_factory, session):
    temperatures = seasonal_temperatures("2003-01-01", "2026-09-27")
    temperatures.iloc[-8:] += 2.5
    series = add_series(session, temperatures)
    monkeypatch.setattr("heatwaves.db.SessionLocal", session_factory)

    assert sync.main(["--recompute"]) == 0

    session.refresh(series)
    assert series.latest_date == dt.date(2026, 9, 27)
    assert session.scalars(select(Event).where(Event.end_date == series.latest_date)).one().duration >= 8


def test_a_recompute_that_cant_write_the_files_fails(monkeypatch, session_factory, session):
    add_series(session, seasonal_temperatures("2003-01-01", "2026-09-27"))
    monkeypatch.setattr("heatwaves.db.SessionLocal", session_factory)

    def fails(*args: object) -> None:
        raise OSError("No space left on device")

    monkeypatch.setattr(sync.products, "write", fails)

    assert sync.main(["--recompute"]) == 1


def test_a_recompute_and_the_catalog_wait_for_any_other_sync(monkeypatch, session_factory, session):
    add_series(session, seasonal_temperatures("2003-01-01", "2026-09-27"))
    locked: list[Session] = []
    monkeypatch.setattr("heatwaves.db.SessionLocal", session_factory)
    monkeypatch.setattr(sync, "one_sync_at_a_time", locked.append)

    assert sync.main(["--recompute"]) == 0
    assert len(locked) == 1
    ensure_catalog(session, recorded_erddap(CATALOG, []))
    assert locked[1] is session


class HeldSource:
    """A buoy source that, asked what changed, answers only once let go: a sync partway through a download."""

    def __init__(self, download: Download | None = None) -> None:
        self.download = download
        self.asked = threading.Event()
        self.go = threading.Event()
        self.started_from: list[dt.datetime | None] = []  # the high-water mark of each fetch

    def fetch(self, series: Sequence[Series]) -> Download | None:
        self.started_from.append(series[0].modified_through)
        self.asked.set()
        if not self.go.wait(10):
            raise TimeoutError("never let go")
        return self.download

    def page_url(self, series: Series) -> str:
        return ""


# Whether anyone waits for the sync's lock: a lock on a bigint key is split into classid and objid.
WAITING_FOR_THE_SYNC_LOCK = text(
    "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted"
    " AND (classid::bigint << 32 | objid::bigint) = :key"
)


def waits_for_the_sync_lock(session_factory: sessionmaker, task: Future) -> bool:
    """Whether `task` comes to wait for the sync's lock, rather than finishing, within a few seconds."""
    deadline = monotonic() + 10
    while not task.done() and monotonic() < deadline:
        with session_factory() as observer:
            if observer.scalar(WAITING_FOR_THE_SYNC_LOCK, {"key": sync.SYNC_LOCK}):
                return True
        sleep(0.02)
    return False


@postgres_only
def test_a_second_sync_waits_for_the_first_to_commit(session_factory, series):
    stored_through = dt.datetime(2026, 9, 28, 16, tzinfo=dt.UTC)
    day = dt.date(2026, 9, 28)
    new_day = pd.DataFrame({"value": [15.1], "hours": [24]}, index=pd.DatetimeIndex([day], name="date"))
    first = HeldSource(Download(day, day, {series.id: new_day}, stored_through))
    second = HeldSource()  # nothing new
    second.go.set()

    with ThreadPoolExecutor(2) as pool:
        try:
            syncing = pool.submit(sync_one, session_factory, {"buoy": first}, series.id)
            assert first.asked.wait(10)  # the first has the lock, and is partway through its download
            waiting = pool.submit(sync_one, session_factory, {"buoy": second}, series.id)

            assert waits_for_the_sync_lock(session_factory, waiting)
            assert second.started_from == []
        finally:
            first.go.set()
        assert syncing.result(timeout=10) == "updated"
        assert waiting.result(timeout=10) == "unchanged"

    # It started from where the first left off, rather than downloading the same days again.
    assert second.started_from == [stored_through]


def recompute(session_factory: sessionmaker) -> object:
    return sync.main(["--recompute"])


def update_catalog(session_factory: sessionmaker) -> object:
    with session_factory() as session:
        return ensure_catalog(session, recorded_erddap(CATALOG, []))


@postgres_only
@pytest.mark.parametrize(("other", "done"), [(recompute, 0), (update_catalog, True)])
def test_a_recompute_or_the_catalog_waits_for_a_sync_in_progress(
    monkeypatch, session_factory, series, other: Callable[[sessionmaker], object], done
):
    monkeypatch.setattr("heatwaves.db.SessionLocal", session_factory)
    held = HeldSource()

    with ThreadPoolExecutor(2) as pool:
        try:
            syncing = pool.submit(sync_one, session_factory, {"buoy": held}, series.id)
            assert held.asked.wait(10)
            waiting = pool.submit(other, session_factory)

            assert waits_for_the_sync_lock(session_factory, waiting)
        finally:
            held.go.set()
        assert syncing.result(timeout=10) == "unchanged"
        assert waiting.result(timeout=30) == done


def test_a_series_has_one_heatwave_starting_on_a_day(session):
    series = add_series(session, seasonal_temperatures("2021-01-01", "2021-12-31"))
    day = dt.date(2021, 7, 1)
    for end in (day + dt.timedelta(days=4), day + dt.timedelta(days=9)):
        session.add(
            Event(
                series_id=series.id,
                start_date=day,
                end_date=end,
                peak_date=day,
                max_intensity=2.0,
                mean_intensity=1.0,
                category=1,
            )
        )

    with pytest.raises(IntegrityError):
        session.commit()
