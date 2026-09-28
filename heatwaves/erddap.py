"""A small client for the ERDDAP tabledap requests this app makes.

An ERDDAP request is a URL: the dataset, an output file type, the variables
to return and any constraints, e.g.

    /tabledap/A01_ocean_001m.nc?time,temperature&time>=2026-01-01T00:00:00Z

Every ERDDAP server documents the grammar at /erddap/tabledap/documentation.html.
erddapy covers far more of it; this app needs only these few calls.
"""

import datetime as dt
import tempfile
from collections.abc import Sequence
from urllib.parse import quote

import httpx
import xarray as xr


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
        query = ",".join(variables) + "".join("&" + quote(c, safe="=!,") for c in constraints)
        return f"{self.base_url}/tabledap/{dataset_id}.{file_type}?{query}"

    def page_url(self, dataset_id: str) -> str:
        """ERDDAP's human-facing data access form for a dataset."""
        return f"{self.base_url}/tabledap/{dataset_id}.html"

    def rows(self, dataset_id: str, variables: Sequence[str], constraints: Sequence[str] = ()) -> list[dict]:
        """Matching rows as dicts, or an empty list when nothing matches."""
        response = self._get(self.url(dataset_id, variables, constraints, "json"))
        if response is None:
            return []
        table = response.json()["table"]
        return [dict(zip(table["columnNames"], row, strict=True)) for row in table["rows"]]

    def dataset(
        self, dataset_id: str, variables: Sequence[str], constraints: Sequence[str] = ()
    ) -> xr.Dataset | None:
        """Matching rows as an in-memory xarray Dataset, read from ERDDAP's NetCDF output."""
        response = self._get(self.url(dataset_id, variables, constraints, "nc"))
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


def format_time(value: dt.datetime | dt.date) -> str:
    """An ERDDAP constraint time: ISO 8601 in UTC."""
    if not isinstance(value, dt.datetime):
        value = dt.datetime.combine(value, dt.time(), dt.UTC)
    return value.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value)
