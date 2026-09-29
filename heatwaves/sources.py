"""Where series come from: one fetcher per source.

A source fetches what changed for every series in one of its datasets, in
as few requests as it can, and returns each series' daily values over a
span of days. Storing them and recomputing heatwaves is the same for every
source (heatwaves.sync).
"""

import datetime as dt
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

import httpx
import numpy as np
import pandas as pd
import xarray as xr

from heatwaves import qc
from heatwaves.config import settings
from heatwaves.erddap import Axis, Erddap, format_time, parse_time
from heatwaves.models import Series
from heatwaves.stations import OISST, OISST_PRELIMINARY

_EMPTY = pd.DataFrame({"value": pd.Series(dtype=float), "hours": pd.Series(dtype=float)})


@dataclass(frozen=True)
class Download:
    first_day: dt.date
    last_day: dt.date  # inclusive; every stored day in the span is replaced
    daily: dict[int, pd.DataFrame]  # by series ID: `value` and `hours`, indexed by day
    modified_through: dt.datetime  # where the next fetch starts


class Source(Protocol):
    def fetch(self, series: Sequence[Series]) -> Download | None:
        """What changed since the series' `modified_through`, or None if nothing did.

        `series` share a source and a dataset.
        """
        ...

    def page_url(self, series: Series) -> str:
        """Where people can see and download a series' data."""
        ...


def connect(client: httpx.Client) -> dict[str, Source]:
    """Every source, by the name series use for it, reading through `client`."""
    return {
        "buoy": TabledapSource(Erddap(settings.erddap_url, client)),
        "satellite": GriddapSource(Erddap(settings.coastwatch_url, client), OISST, OISST_PRELIMINARY),
    }


class TabledapSource:
    """Buoy data from ERDDAP tabledap, fetched incrementally using `time_modified`.

    The data provider stamps every row it writes with `time_modified`. Two
    small requests, reduced server-side with orderByMax and orderByMinMax,
    find the newest stamp and the span of days touched since the last sync;
    only those days are then downloaded and re-averaged. A normal hourly sync
    re-reads a couple of days per dataset. When UMaine replaces real-time
    data with post-recovery data, the new stamps pull the reprocessed days in
    automatically. The first sync reads each dataset's full history, about
    25 years.
    """

    # Rows can reach ERDDAP after rows with later time_modified stamps.
    # Whenever anything new has been stamped, the sync re-reads this far
    # behind the newest stamp it had already seen, to catch them.
    OVERLAP = dt.timedelta(days=2)

    def __init__(self, erddap: Erddap) -> None:
        self.erddap = erddap

    def page_url(self, series: Series) -> str:
        return self.erddap.page_url(series.dataset_id, "tabledap")

    def fetch(self, series: Sequence[Series]) -> Download | None:
        dataset_id = series[0].dataset_id
        seen = _seen(series)
        since = [f"time_modified>{format_time(seen - self.OVERLAP)}"] if seen is not None else []

        newest = self.erddap.rows(dataset_id, ["time_modified"], [*since, 'orderByMax("time_modified")'])
        if not newest:
            return None
        modified_through = parse_time(newest[0]["time_modified"])
        if modified_through == seen:
            # Nothing stamped since the last sync. Re-reading the overlap
            # anyway would re-fetch a retired buoy's last reprocessing every hour.
            return None
        span = self.erddap.rows(
            dataset_id,
            ["time"],
            [*since, f"time_modified<={format_time(modified_through)}", 'orderByMinMax("time")'],
        )
        first_day = parse_time(span[0]["time"]).date()
        last_day = parse_time(span[-1]["time"]).date()

        raw = self.erddap.dataset(
            dataset_id,
            qc.columns([s.variable for s in series]),
            [f"time>={format_time(first_day)}", f"time<{format_time(last_day + dt.timedelta(days=1))}"],
        )
        daily = {s.id: qc.daily_means(raw, s.variable) if raw is not None else _EMPTY for s in series}
        return Download(first_day, last_day, daily, modified_through)


class GriddapSource:
    """Daily gridded data from ERDDAP griddap: a final product and the preliminary one it replaces.

    Each series is one grid cell: the nearest to its buoy that has data (a
    coastal buoy's own cell may be masked as land), chosen on its first
    fetch. Every cell is read in the same request, a box spanning them all,
    since ERDDAP's cost is in reading each day's grid rather than in the
    size of the box.

    Every hour one tiny request asks for the preliminary product's newest
    day. When there is a new one, the last REREAD days are read again: from
    the final product as far as it goes, then from the preliminary one. So
    preliminary days are replaced by final ones as they appear, the same way
    UMaine's post-recovery data replaces its real-time data. The first fetch
    reads everything from `start`, a year per request.
    """

    REREAD = dt.timedelta(days=30)
    SEARCH = 0.5  # degrees around a buoy searched for its cell

    def __init__(
        self,
        erddap: Erddap,
        final: str,
        preliminary: str,
        variable: str = "sst",
        levels: Sequence[Axis] = (0.0,),  # positions on any axes between time and latitude
        start: dt.date = dt.date(2001, 1, 1),  # the first buoy records
    ) -> None:
        self.erddap = erddap
        self.final = final
        self.preliminary = preliminary
        self.variable = variable
        self.levels = levels
        self.start = start

    def page_url(self, series: Series) -> str:
        return self.erddap.page_url(self.final, "griddap")

    def fetch(self, series: Sequence[Series]) -> Download | None:
        newest = self.erddap.last_time(self.preliminary)
        seen = _seen(series)
        if seen is not None and newest <= seen:
            return None

        final_through = self.erddap.last_time(self.final).date()
        unplaced = [s for s in series if s.latitude is None]
        if unplaced:
            self._place(unplaced, final_through)

        first_day = self.start if seen is None else (seen - self.REREAD).date()
        last_day = newest.date()
        spans = [(self.final, first, last) for first, last in years(first_day, min(final_through, last_day))]
        if last_day > final_through:
            spans.append((self.preliminary, max(first_day, final_through + dt.timedelta(days=1)), last_day))
        grids = [self._box(dataset_id, first, last, series) for dataset_id, first, last in spans]
        grids = [grid[self.variable] for grid in grids if grid is not None]
        daily = {s.id: _cell(grids, s) for s in series}
        return Download(first_day, last_day, daily, newest)

    def _box(
        self, dataset_id: str, first: dt.date, last: dt.date, series: Sequence[Series]
    ) -> xr.Dataset | None:
        """Every series' cell from `first` to `last`, in one request."""
        latitudes = [s.latitude for s in series if s.latitude is not None]
        longitudes = [s.longitude for s in series if s.longitude is not None]
        grid = self.erddap.grid(
            dataset_id,
            self.variable,
            [
                (_noon(first), _noon(last)),
                *self.levels,
                (min(latitudes), max(latitudes)),
                (min(longitudes), max(longitudes)),
            ],
        )
        # When a range ends on a day the product is missing, ERDDAP moves
        # that end to the nearest day it has, which can be outside the range
        # and so also in the neighbouring request.
        return grid.sel(time=slice(first.isoformat(), last.isoformat())) if grid is not None else None

    def _place(self, series: Sequence[Series], day: dt.date) -> None:
        """Choose each series' cell from one day of the grid around its buoy."""
        positions = [(s.buoy.latitude, s.buoy.longitude) for s in series]
        latitudes = [lat for lat, _ in positions if lat is not None]
        longitudes = [lon for _, lon in positions if lon is not None]
        if len(latitudes) < len(positions) or len(longitudes) < len(positions):
            raise ValueError("A buoy without a position can't be matched to a grid cell")
        grid = self.erddap.grid(
            self.final,
            self.variable,
            [
                _noon(day),
                *self.levels,
                (min(latitudes) - self.SEARCH, max(latitudes) + self.SEARCH),
                (min(longitudes) - self.SEARCH, max(longitudes) + self.SEARCH),
            ],
        )
        if grid is None:
            raise ValueError(f"{self.final} has no data for {day} around the buoys")
        values = _surface(grid[self.variable])
        for each, lat, lon in zip(series, latitudes, longitudes, strict=True):
            each.latitude, each.longitude, each.distance_km = nearest_cell(values, lat, lon, self.SEARCH)


def nearest_cell(
    values: xr.DataArray, latitude: float, longitude: float, within: float
) -> tuple[float, float, float]:
    """The centre of the cell with data nearest a point, and its distance from it in km.

    `values` is a latitude-longitude grid; only cells within `within`
    degrees of the point are considered.
    """
    lat, lon = xr.broadcast(values["latitude"], values["longitude"])
    distances = lat.copy(data=distance_km(latitude, longitude, lat.values, lon.values))
    near = (abs(lat - latitude) <= within) & (abs(lon - longitude) <= within)
    candidates = distances.where(values.notnull() & near)
    if candidates.isnull().all():
        raise ValueError(f"No cell with data within {within}° of {latitude}, {longitude}")
    cell = candidates.argmin(...)
    return float(lat[cell]), float(lon[cell]), float(candidates[cell])


def distance_km(lat1: float, lon1: float, lat2: np.ndarray, lon2: np.ndarray) -> np.ndarray:
    """Great-circle distances from one point to others, on a spherical Earth."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    half = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371.0 * np.arcsin(np.sqrt(half))


def years(first: dt.date, last: dt.date) -> list[tuple[dt.date, dt.date]]:
    """Split first to last, inclusive, at each new year: one request each."""
    if first > last:
        return []
    return [
        (max(first, dt.date(year, 1, 1)), min(last, dt.date(year, 12, 31)))
        for year in range(first.year, last.year + 1)
    ]


def _seen(series: Sequence[Series]) -> dt.datetime | None:
    """How far every series has been read; None if any is new, so the whole dataset is read."""
    stamps = [s.modified_through for s in series if s.modified_through is not None]
    return min(stamps) if len(stamps) == len(series) else None


def _noon(day: dt.date) -> str:
    # Daily grids are stamped at noon UTC.
    return f"{day.isoformat()}T12:00:00Z"


def _cell(grids: Sequence[xr.DataArray], series: Series) -> pd.DataFrame:
    """One series' daily values from its cell, indexed by day."""
    if not grids:
        return _EMPTY
    cells = [
        grid.sel(latitude=series.latitude, longitude=series.longitude, method="nearest") for grid in grids
    ]
    values = _surface(xr.concat(cells, dim="time"), keep=("time",)).to_series().dropna()
    days = pd.DatetimeIndex(values.index).normalize().rename("date")
    return pd.DataFrame({"value": values.to_numpy(dtype=float), "hours": None}, index=days)


def _surface(values: xr.DataArray, keep: Sequence[str] = ("latitude", "longitude")) -> xr.DataArray:
    """The first position on every other axis: OISST's single level, or a single day."""
    return values.isel({dim: 0 for dim in values.dims if dim not in keep})
