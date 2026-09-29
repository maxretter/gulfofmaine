"""The satellite source against recorded CoastWatch responses (see tests/conftest.py)."""

import datetime as dt
from collections.abc import Sequence

import httpx
import numpy as np
import pandas as pd
import pytest
import xarray as xr
from sqlalchemy import insert, select

from heatwaves.erddap import Axis, Erddap
from heatwaves.models import DailyMean, Series
from heatwaves.sources import GriddapSource, nearest_cell, years
from heatwaves.stations import OISST, OISST_PRELIMINARY
from heatwaves.sync import ensure_catalog, sync_series
from tests.conftest import CATALOG, COASTWATCH, OISST_SYNC, recorded_erddap

# Each buoy's nearest OISST cell and its distance from the buoy, in km.
CELLS = {
    "A01": (42.625, -70.625, 12.7),
    "B01": (43.125, -70.375, 7.5),
    "E01": (43.625, -69.375, 9.1),
    "F01": (44.125, -68.875, 12.7),
    "I01": (44.125, -68.125, 2.8),
    "M01": (43.375, -67.875, 12.0),
}
NEWEST = dt.datetime(2026, 9, 27, 12, tzinfo=dt.UTC)  # in oisst_preliminary_last.json


@pytest.fixture
def satellites(session) -> list[Series]:
    """Every buoy's satellite series, as the catalog creates them: no cell or data yet."""
    ensure_catalog(session, recorded_erddap(CATALOG, []))
    return list(session.scalars(select(Series).where(Series.source == "satellite").order_by(Series.buoy_id)))


def coastwatch(requests: list[str], start: dt.date = dt.date(2001, 1, 1)):
    erddap = recorded_erddap(OISST_SYNC, requests, COASTWATCH)
    return {"satellite": GriddapSource(erddap, OISST, OISST_PRELIMINARY, start=start)}


def days_of(session, series: Series) -> dict[dt.date, float]:
    return dict(
        session.execute(select(DailyMean.date, DailyMean.value).where(DailyMean.series_id == series.id)).all()
    )


def test_first_sync_places_each_buoy_in_a_cell_then_reads_both_products(session, satellites):
    requests: list[str] = []

    assert sync_series(session, coastwatch(requests, start=dt.date(2026, 8, 27)), satellites[0])

    assert {s.buoy_id: (s.latitude, s.longitude, round(s.distance_km or 0, 1)) for s in satellites} == CELLS
    # One request per product covers all six cells.
    _, _, cells, final, preliminary = requests
    assert "[(2026-09-13T12:00:00Z)][(0.0)][(42.0183):(44.6016)][(-71.0681):(-67.4)]" in cells
    assert "ncdcOisst21Agg_LonPM180.nc?sst[(2026-08-27T12:00:00Z):(2026-09-13T12:00:00Z)]" in final
    assert "ncdcOisst21NrtAgg_LonPM180.nc?sst[(2026-09-14T12:00:00Z):(2026-09-27T12:00:00Z)]" in preliminary
    for series in satellites:
        days = days_of(session, series)
        assert (min(days), max(days)) == (dt.date(2026, 8, 27), dt.date(2026, 9, 27))
        assert all(10 < value < 22 for value in days.values())  # late-summer sea surface, °C
        assert series.modified_through == NEWEST
    hours = session.scalars(select(DailyMean.hours).where(DailyMean.series_id == satellites[0].id)).all()
    assert set(hours) == {None}  # a daily analysis, not hourly readings


def test_a_new_day_rereads_the_last_30_days(session, satellites):
    for series in satellites:
        series.latitude, series.longitude, series.distance_km = CELLS[series.buoy_id]
        series.modified_through = dt.datetime(2026, 9, 26, 12, tzinfo=dt.UTC)
    # Stale values, as if earlier syncs had stored preliminary days.
    a01 = satellites[0]
    stale = [dt.date(2026, 8, 20) + dt.timedelta(days=n) for n in range(38)]
    session.execute(insert(DailyMean), [{"series_id": a01.id, "date": d, "value": -1.0} for d in stale])
    requests: list[str] = []

    assert sync_series(session, coastwatch(requests), a01)

    assert len(requests) == 4  # no cells to choose, no backfill
    days = days_of(session, a01)
    assert days[dt.date(2026, 8, 26)] == -1.0  # older than 30 days: kept
    assert all(days[d] > 10 for d in stale if d >= dt.date(2026, 8, 27))


def test_nothing_new_takes_one_request(session, satellites):
    for series in satellites:
        series.modified_through = NEWEST
    requests: list[str] = []

    assert not sync_series(session, coastwatch(requests), satellites[0])

    assert len(requests) == 1
    assert all(s.synced_at is not None for s in satellites)


def test_nearest_cell_skips_cells_masked_as_land():
    # The point sits in the south-west cell, which is land; its east neighbor is nearer than its north one.
    grid = xr.DataArray(
        [[np.nan, 15.0], [16.0, 17.0]],
        coords={"latitude": [44.125, 44.375], "longitude": [-68.875, -68.625]},
        dims=["latitude", "longitude"],
    )

    lat, lon, km = nearest_cell(grid, 44.15, -68.85, within=0.5)

    assert (lat, lon) == (44.125, -68.625)
    assert km == pytest.approx(18.1, abs=0.1)
    with pytest.raises(ValueError, match="No cell with data"):
        nearest_cell(grid.where(grid.isnull()), 44.15, -68.85, within=0.5)


def test_backfill_asks_for_a_year_at_a_time():
    assert years(dt.date(2001, 7, 10), dt.date(2003, 2, 1)) == [
        (dt.date(2001, 7, 10), dt.date(2001, 12, 31)),
        (dt.date(2002, 1, 1), dt.date(2002, 12, 31)),
        (dt.date(2003, 1, 1), dt.date(2003, 2, 1)),
    ]
    assert years(dt.date(2026, 9, 14), dt.date(2026, 9, 13)) == []


class SnappingErddap(Erddap):
    """Answers like ERDDAP when a range ends on a missing day: with the nearest day it has instead.

    Every day through Jan 3, 2026 is there except Dec 31, 2025.
    """

    DAYS = pd.date_range("2025-12-01T12:00", "2026-01-03T12:00").drop([pd.Timestamp("2025-12-31T12:00")])

    def __init__(self) -> None:
        super().__init__(COASTWATCH, httpx.Client())

    def last_time(self, dataset_id: str) -> dt.datetime:
        return self.DAYS[-1].to_pydatetime().replace(tzinfo=dt.UTC)

    def grid(self, dataset_id: str, variable: str, axes: Sequence[Axis]) -> xr.Dataset | None:
        span = axes[0]
        assert isinstance(span, tuple)  # a range of days
        ends = pd.DatetimeIndex([str(end) for end in span]).tz_localize(None)
        start, end = self.DAYS.get_indexer(ends, method="nearest")
        days = self.DAYS[start : end + 1]
        values = np.full((len(days), 1, 1, 1), 15.0)
        coords = {"time": days, "zlev": [0.0], "latitude": [42.625], "longitude": [-70.625]}
        return xr.Dataset({variable: (list(coords), values)}, coords=coords)


def test_a_day_erddap_snaps_to_is_stored_once(session, satellites):
    a01 = satellites[0]
    for series in satellites:
        series.latitude, series.longitude, series.distance_km = CELLS["A01"]
    source = GriddapSource(SnappingErddap(), OISST, OISST_PRELIMINARY, start=dt.date(2025, 12, 30))

    # 2025 ends on the missing Dec 31, so ERDDAP answers with Jan 1, which 2026's request also returns.
    assert sync_series(session, {"satellite": source}, a01)

    days = sorted(days_of(session, a01))
    assert days == [dt.date(2025, 12, 30), dt.date(2026, 1, 1), dt.date(2026, 1, 2), dt.date(2026, 1, 3)]
