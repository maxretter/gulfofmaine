"""The NetCDF and CSV products, against the JSON API and the CF and ACDD conventions."""

import io
import os
import stat
from pathlib import Path

import pandas as pd
import pytest
import xarray as xr
from compliance_checker.runner import CheckSuite
from fastapi.responses import FileResponse

from heatwaves import api, products
from heatwaves.main import app
from tests import sample
from tests.conftest import api_client, fresh_database
from tests.sample import GAP, SATELLITE_CELL


@pytest.fixture(scope="module")
def directory(tmp_path_factory):
    return tmp_path_factory.mktemp("products")


@pytest.fixture(scope="module")
def sample_database(directory):
    """The sample record (tests/sample.py), with every product written.

    Built once for the module, so tests here can't ask for a fresh database
    of their own: on Postgres, that one's DROP TABLE would wait on this one.
    """
    with fresh_database() as session_factory:
        with session_factory() as session:
            sample.build(session)
            products.write(session, directory)
        yield session_factory


@pytest.fixture(scope="module")
def client(sample_database, directory):
    app.dependency_overrides[api.products_dir] = lambda: directory
    with api_client(sample_database) as client:
        yield client


def open_netcdf(content: bytes, tmp_path: Path) -> xr.Dataset:
    path = tmp_path / "download.nc"
    path.write_bytes(content)
    return xr.load_dataset(path)


def read_csv(content: bytes, **kwargs) -> pd.DataFrame:
    # round_trip parses each number to the float it was written from, as JSON does.
    return pd.read_csv(io.BytesIO(content), float_precision="round_trip", **kwargs)


def api_daily(client, depth: int, start, end, variable: str = "temperature") -> pd.DataFrame:
    days = client.get(f"/api/buoys/A01/{depth}/daily?start={start}&end={end}&variable={variable}").json()
    return pd.DataFrame(days).set_index("date").astype(float)


def test_daily_files_match_the_json_api_exactly_to_its_decimals(client, tmp_path):
    nc = open_netcdf(client.get("/api/data/A01/50.nc").content, tmp_path).to_dataframe()
    nc.index = pd.DatetimeIndex(nc.index).strftime("%Y-%m-%d")
    csv = read_csv(client.get("/api/data/a01/50.csv").content, index_col="date")

    # Every day from the first to the last with temperature or salinity.
    assert (nc.index[0], nc.index[-1]) == ("2003-01-01", "2021-07-15")
    start, end = nc.index[0], nc.index[-1]
    # The NetCDF keeps every digit stored; the API rounds each number to api.DECIMALS, and so does the CSV.
    assert not nc["temperature"].equals(nc["temperature"].round(api.DECIMALS))
    places = client.get("/api/data/A01/50.csv").text.splitlines()[1].split(",")[1].split(".")[1]
    assert 0 < len(places) <= api.DECIMALS
    for table in (nc.round(api.DECIMALS), csv):
        for depth, variable, prefix in ((50, "temperature", "temperature"), (0, "temperature", "satellite")):
            expected = api_daily(client, depth, start, end, variable)
            value = "temperature" if prefix == "temperature" else "satellite_temperature"
            assert table[value].equals(expected["value"])
            for column in ("climatology", "threshold", "anomaly"):
                assert table[f"{prefix}_{column}"].equals(expected[column]), column
        expected = api_daily(client, 50, start, end, "salinity")
        for column, name in (("value", "salinity"), ("climatology", "salinity_climatology")):
            assert table[name].equals(expected[column])
        assert table["salinity_anomaly"].equals(expected["anomaly"])


def test_daily_flags_follow_the_heatwaves(client, tmp_path):
    ds = open_netcdf(client.get("/api/data/A01/50.nc").content, tmp_path)
    category = ds.heatwave_category.to_series()
    origin = ds.heatwave_origin.to_series()
    events = client.get("/api/events?depth=50").json()

    heatwave = pd.Series(False, index=category.index)
    for event in events:
        days = slice(event["start_date"], event["end_date"])
        assert (category[days] == event["category"]).all()
        assert (origin[days] == products.ORIGIN_FLAGS.index("offshore")).all()
        heatwave[days] = True
    assert any(event["start_date"].startswith("2021-04") for event in events)
    observed = ds.temperature.to_series().notna()
    # No heatwave on the other days with data, and neither flag on days with neither.
    assert (category[~heatwave & observed] == 0).all()
    assert (origin[~heatwave & observed] == 0).all()
    assert category[GAP].isna().all()
    assert origin[GAP].isna().all()
    assert ds.heatwave_category.attrs["flag_meanings"] == "none moderate strong severe extreme"
    # The origin labels heatwaves.origin.Origin lists, in its order, after none.
    assert ds.heatwave_origin.attrs["flag_meanings"] == "none offshore surface unclear"
    assert list(ds.heatwave_origin.attrs["flag_values"]) == [0, 1, 2, 3]

    satellite = ds.satellite_heatwave_category.to_series()
    assert (satellite["2021-04-01":"2021-04-20"] > 0).all()
    assert (ds.satellite_latitude.item(), ds.satellite_longitude.item()) == SATELLITE_CELL[:2]

    csv = read_csv(client.get("/api/data/A01/50.csv").content, index_col="date")
    assert set(csv["heatwave_origin"].dropna()) == {"none", "offshore"}
    assert csv["heatwave_category"]["2021-04-20"] >= 1


def test_origin_is_missing_at_depths_it_isnt_judged(client, tmp_path):
    ds = open_netcdf(client.get("/api/data/A01/1.nc").content, tmp_path)

    assert ds.heatwave_origin.isnull().all()
    assert ds.salinity.isnull().all()  # none at 1 m
    assert (ds.heatwave_category.fillna(0) >= 0).all()
    assert ds.series_id.item() == "A01_001m"
    assert ds.attrs["title"] == "Marine heatwaves at A01 (Test Buoy), 1 m"


def test_events_match_the_json_api_exactly(client, tmp_path):
    # All but the status, which is of the day it's asked: the files are rewritten only as the record changes.
    expected = pd.DataFrame(client.get("/api/events").json()).drop(columns="status")
    expected = expected.sort_values(["start_date", "buoy_id", "depth"], ignore_index=True)
    csv = read_csv(client.get("/api/data/events.csv").content)

    assert list(csv.columns) == list(expected.columns)
    assert csv.astype(object).where(csv.notna(), None).to_dict("records") == expected.to_dict("records")

    nc = open_netcdf(client.get("/api/data/events.nc").content, tmp_path)
    assert list(nc.time.dt.strftime("%Y-%m-%d").values) == list(expected["start_date"])
    assert list(nc.station.values) == list(expected["buoy_id"])
    assert nc.max_intensity.values.tolist() == expected["max_intensity"].tolist()
    assert nc.duration.values.tolist() == expected["duration"].tolist()
    labeled = expected["origin"].notna()
    assert nc.origin.isnull().values.tolist() == (~labeled).tolist()


def failures(path: Path, checker: str) -> list[tuple[int, str, list[str]]]:
    """Every check a file fails, as (priority, name, messages); 3 is high, 2 medium, 1 low."""
    suite = CheckSuite()
    suite.load_all_available_checkers()
    ds = suite.load_dataset(str(path))
    [(results, errors)] = suite.run_all(ds, [checker], skip_checks=[]).values()
    # compliance-checker 6.1 fails to check domain variables in a point file:
    # it looks for a cf_role variable, which CF gives only to other featureTypes.
    if ds.featureType == "point":
        errors.pop("check_domain_variables", None)
    assert not errors, errors
    return [
        (result.weight, str(result.name), result.msgs)
        for result in results
        if result.value[0] < result.value[1]
    ]


def test_every_file_passes_the_cf_check(client, directory):
    files = sorted(directory.rglob("*.nc"))
    assert len(files) == 3
    for path in files:
        assert failures(path, "cf:1.11") == [], path.name


# Global attributes the files leave out, for now: an individual has no
# institution, and no email is published.
NOT_GIVEN = ["creator_email not present", "institution not present", "publisher_email not present"]


def test_every_file_passes_the_acdd_check_but_for_standard_names_cf_lacks(client, directory):
    for path in sorted(directory.rglob("*.nc")):
        ds = xr.open_dataset(path)
        without = {name for name, variable in ds.variables.items() if "standard_name" not in variable.attrs}
        missing = []
        for priority, name, messages in failures(path, "acdd:1.3"):
            if priority == 1:  # suggested only
                continue
            if name == "Global Attributes":
                assert messages == NOT_GIVEN, path.name
            else:
                assert messages == ["standard_name"], (path.name, name)
                missing.append(name.split('"')[1])
        assert set(missing) <= without
        # Flags and identifiers need none; everything measured has one.
        assert "temperature" not in missing and "salinity" not in missing


def test_catalog_lists_each_product_in_both_formats(client, directory):
    catalog = client.get("/api/data").json()

    assert [product["name"] for product in catalog["products"]] == [
        "A01_heatwaves_001m",
        "A01_heatwaves_050m",
        "gom_heatwaves_events",
    ]
    for product in catalog["products"]:
        assert [file["format"] for file in product["files"]] == ["nc", "csv"]
        for file in product["files"]:
            download = client.get(file["url"])
            assert download.status_code == 200
            assert len(download.content) == file["size"]
            head = client.head(file["url"])
            assert (head.status_code, head.content) == (200, b"")
            assert head.headers["content-length"] == str(file["size"])
    assert catalog["products"][1]["depth"] == 50
    assert [variable["name"] for variable in catalog["variables"]] == list(products.DAILY_VARIABLES)
    assert client.get("/api/data/A01/50.nc").headers["content-type"] == "application/x-netcdf"


def test_downloads_serve_byte_ranges_and_revalidate(client):
    # xarray's #mode=bytes reads a file in ranges; browsers revalidate with the ETag.
    part = client.get("/api/data/A01/50.nc", headers={"Range": "bytes=0-99"})
    assert (part.status_code, len(part.content)) == (206, 100)
    assert part.content.startswith(b"CDF")  # NetCDF-3
    whole = client.get("/api/data/A01/50.nc")
    [etag] = whole.headers.get_list("etag")
    assert whole.headers["cache-control"] == "no-cache"
    unchanged = client.get("/api/data/A01/50.nc", headers={"If-None-Match": etag})
    assert (unchanged.status_code, unchanged.headers["etag"]) == (304, etag)

    # A download resumed with the ETag it started with gets the rest, not the whole file again.
    rest = client.get("/api/data/A01/50.nc", headers={"Range": "bytes=100-", "If-Range": etag})
    assert rest.status_code == 206
    assert part.content + rest.content == whole.content


def test_downloads_go_as_the_files_are(client):
    # Not gzipped, so the Content-Length, ETag and byte ranges are all of the file's own bytes.
    download = client.get("/api/data/A01/50.csv", headers={"Accept-Encoding": "gzip"})
    same_days = client.get("/api/buoys/A01/50/daily", headers={"Accept-Encoding": "gzip"})

    assert "content-encoding" not in download.headers
    assert download.headers["content-length"] == str(len(download.content))
    assert same_days.headers["content-encoding"] == "gzip"  # the JSON still is


@pytest.mark.parametrize("headers", [{}, {"Range": "bytes=100-"}])
def test_a_download_is_of_the_file_its_headers_describe(client, directory, tmp_path, monkeypatch, headers):
    path = products.daily_path(tmp_path, "A01", 50, "nc")
    path.parent.mkdir(parents=True)
    path.write_bytes(products.daily_path(directory, "A01", 50, "nc").read_bytes())
    first = path.read_bytes()
    respond = FileResponse.__call__

    async def replaced_first(response, *args):
        # The sync replaces the file once the response's headers are made, before its body is read.
        newer = path.with_suffix(".partial")
        newer.write_bytes(b"newer " + first)
        os.replace(newer, path)
        await respond(response, *args)

    monkeypatch.setattr(FileResponse, "__call__", replaced_first)
    app.dependency_overrides[api.products_dir] = lambda: tmp_path
    try:
        download = client.get("/api/data/A01/50.nc", headers=headers)
    finally:
        app.dependency_overrides[api.products_dir] = lambda: directory

    sent = first[100:] if headers else first
    assert download.content == sent
    assert download.headers["content-length"] == str(len(sent))


def test_downloads_are_404_until_the_sync_writes_them(client, directory, tmp_path):
    app.dependency_overrides[api.products_dir] = lambda: tmp_path
    try:
        assert client.get("/api/data").json()["products"] == []
        assert client.get("/api/data/A01/50.nc").status_code == 404
        assert client.get("/api/data/events.csv").status_code == 404
        assert client.get("/api/data/A01/50.txt").status_code == 422
    finally:
        app.dependency_overrides[api.products_dir] = lambda: directory


def test_the_command_writes_every_product(monkeypatch, sample_database, directory, tmp_path):
    monkeypatch.setattr("heatwaves.db.SessionLocal", sample_database)

    assert products.main(["--out", str(tmp_path)]) == 0

    def names(root: Path) -> list[str]:
        return sorted(str(path.relative_to(root)) for path in root.rglob("*") if path.is_file())

    assert names(tmp_path) == names(directory)
    assert not any(name.endswith(".partial") for name in names(tmp_path))


def test_overlapping_writes_dont_share_a_partial_file(tmp_path):
    # A one-off run writing while the sync job does: in their containers, both are PID 1.
    path = tmp_path / "A01_heatwaves_050m.nc"

    def outer(partial: Path) -> None:
        partial.write_text("outer")
        products._replace(path, lambda inner: inner.write_text("inner"))

    products._replace(path, outer)

    assert path.read_text() == "outer"
    assert [each.name for each in tmp_path.iterdir()] == [path.name]


def test_a_failed_write_leaves_no_partial_file(tmp_path):
    def fail(partial: Path) -> None:
        assert partial.name.startswith(".A01_heatwaves_050m.nc.") and partial.suffix == ".partial"
        partial.write_text("half")
        raise OSError("No space left on device")

    with pytest.raises(OSError, match="No space"):
        products._replace(tmp_path / "A01_heatwaves_050m.nc", fail)
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize(("umask", "mode"), [(0o022, 0o644), (0o002, 0o664)], ids=["022", "002"])
def test_files_get_the_mode_any_new_file_would(tmp_path, umask, mode):
    # The API and ERDDAP read them as other users.
    path = tmp_path / "gom_heatwaves_events.csv"
    previous = os.umask(umask)
    try:
        products._replace(path, lambda partial: partial.write_text("start_date\n"))
    finally:
        os.umask(previous)

    assert stat.S_IMODE(path.stat().st_mode) == mode
