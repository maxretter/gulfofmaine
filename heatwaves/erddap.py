"""A small client for the ERDDAP requests this app makes.

An ERDDAP request is a URL: the dataset, an output file type, then a query.
Tabledap (tables of observations, like the buoys) takes the variables to
return and any constraints; griddap (gridded data, like satellite SST)
takes a variable and a range along each of its axes:

    /tabledap/A01_ocean_001m.nc?time,temperature&time>=2026-01-01T00:00:00Z
    /griddap/ncdcOisst21Agg_LonPM180.nc?sst[(2026-01-01T12:00:00Z):1:(2026-01-31T12:00:00Z)][(0.0)][(42.625)][(-70.625)]

Every ERDDAP server documents the grammar at /erddap/tabledap/documentation.html
and /erddap/griddap/documentation.html. erddapy covers far more of it; this
app needs only these few calls.
"""

import datetime as dt
import re
import tempfile
from collections.abc import Collection, Sequence
from typing import Literal
from urllib.parse import quote

import httpx
import xarray as xr

Protocol = Literal["tabledap", "griddap"]

# An axis position, or a (first, last) range, in the axis' own units.
Axis = str | float | tuple[str | float, str | float]


class Erddap:
    def __init__(self, base_url: str, client: httpx.Client) -> None:
        self.base_url = base_url.rstrip("/")
        self.client = client

    def url(
        self,
        dataset_id: str,
        variables: Sequence[str],
        constraints: Sequence[str] = (),
        file_type: str = "json",
    ) -> str:
        """A tabledap request."""
        query = ",".join(variables) + "".join("&" + quote(c, safe="=!,") for c in constraints)
        return f"{self.base_url}/tabledap/{dataset_id}.{file_type}?{query}"

    def grid_url(self, dataset_id: str, variable: str, axes: Sequence[Axis], file_type: str = "nc") -> str:
        """A griddap request for one variable, with a position or range on each axis, in axis order."""
        query = variable + "".join(f"[{_axis(axis)}]" for axis in axes)
        return f"{self.base_url}/griddap/{dataset_id}.{file_type}?{quote(query, safe='():')}"

    def page_url(self, dataset_id: str, protocol: Protocol = "tabledap") -> str:
        """ERDDAP's human-facing data access form for a dataset."""
        return f"{self.base_url}/{protocol}/{dataset_id}.html"

    def rows(self, dataset_id: str, variables: Sequence[str], constraints: Sequence[str] = ()) -> list[dict]:
        """Matching rows as dicts, or an empty list when nothing matches."""
        return self._table(self.url(dataset_id, variables, constraints, "json"))

    def catalog(self, dataset_ids: Collection[str], variables: Sequence[str]) -> list[dict]:
        """These datasets' rows in the server's allDatasets table: `datasetID`, then `variables`."""
        pattern = "|".join(re.escape(dataset_id) for dataset_id in dataset_ids)
        return self.rows("allDatasets", ["datasetID", *variables], [f'datasetID=~"^({pattern})$"'])

    def dataset(
        self, dataset_id: str, variables: Sequence[str], constraints: Sequence[str] = ()
    ) -> xr.Dataset | None:
        """Matching rows as an in-memory xarray Dataset, read from ERDDAP's NetCDF output."""
        return self._netcdf(self.url(dataset_id, variables, constraints, "nc"))

    def grid(self, dataset_id: str, variable: str, axes: Sequence[Axis]) -> xr.Dataset | None:
        """Part of a gridded dataset, or None when the request is outside its axes."""
        return self._netcdf(self.grid_url(dataset_id, variable, axes))

    def last_time(self, dataset_id: str) -> dt.datetime:
        """The newest time in a gridded dataset: one tiny request."""
        [row] = self._table(f"{self.base_url}/griddap/{dataset_id}.json?{quote('time[last]')}")
        return parse_time(row["time"])

    def _table(self, url: str) -> list[dict]:
        response = self._get(url)
        if response is None:
            return []
        table = response.json()["table"]
        return [dict(zip(table["columnNames"], row, strict=True)) for row in table["rows"]]

    def _netcdf(self, url: str) -> xr.Dataset | None:
        response = self._get(url)
        if response is None:
            return None
        # netCDF-C can't open some small classic-format files from memory
        # (it fails with EPERM), so the response goes through a temporary file.
        with tempfile.NamedTemporaryFile(suffix=".nc") as file:
            file.write(response.content)
            file.flush()
            with xr.open_dataset(file.name, engine="netcdf4") as ds:
                return ds.load()

    def _get(self, url: str) -> httpx.Response | None:
        response = self.client.get(url)
        # ERDDAP reports an empty result as a 404 rather than an empty table.
        if response.status_code == 404 and b"no matching results" in response.content:
            return None
        response.raise_for_status()
        return response


def _axis(axis: Axis) -> str:
    if isinstance(axis, tuple):
        first, last = axis
        return f"({first}):({last})"
    return f"({axis})"


def format_time(value: dt.datetime | dt.date) -> str:
    """An ERDDAP constraint time: ISO 8601 in UTC."""
    if not isinstance(value, dt.datetime):
        value = dt.datetime.combine(value, dt.time(), dt.UTC)
    return value.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value)
