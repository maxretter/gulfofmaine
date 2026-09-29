"""erddap/datasets.xml in a real ERDDAP, serving the sample products (tests/sample.py).

CI runs these against ERDDAP in Docker; without ERDDAP_URL they are skipped.

    uv run python -m tests.sample sample-products
    docker build -t gom-heatwaves-erddap erddap
    docker run -d -p 8080:8080 -v "$PWD/sample-products:/data/products:ro" gom-heatwaves-erddap
    ERDDAP_URL=http://localhost:8080/erddap SAMPLE_PRODUCTS=sample-products uv run pytest tests/test_erddap.py
"""

import os
from pathlib import Path
from urllib.parse import quote

import numpy as np
import pandas as pd
import pytest

from heatwaves import products

ERDDAP = os.environ.get("ERDDAP_URL", "")
SAMPLE = Path(os.environ.get("SAMPLE_PRODUCTS", "sample-products"))

pytestmark = pytest.mark.skipif(not ERDDAP, reason="needs ERDDAP_URL: an ERDDAP serving erddap/datasets.xml")


def tabledap(dataset: str, query: str) -> pd.DataFrame:
    """A tabledap CSV request; ERDDAP's second row holds the units."""
    return pd.read_csv(
        f"{ERDDAP}/tabledap/{dataset}.csv?{quote(query, safe='=&,<>')}",
        skiprows=[1],
        float_precision="round_trip",
    )


def test_both_datasets_load():
    catalog = tabledap("allDatasets", "datasetID,cdm_data_type")

    loaded = dict(zip(catalog["datasetID"], catalog["cdm_data_type"], strict=True))
    assert loaded["gom_heatwaves_daily"] == "TimeSeries"
    assert loaded["gom_heatwaves_events"] == "Point"


def test_every_variable_in_the_files_is_served():
    info = pd.read_csv(f"{ERDDAP}/info/gom_heatwaves_daily/index.csv")
    served = set(info.loc[info["Row Type"] == "variable", "Variable Name"])

    assert set(products.DAILY_VARIABLES) <= served


def test_daily_values_match_the_files():
    for path in sorted((SAMPLE / "daily").glob("*.csv")):
        buoy, _, depth = path.stem.split("_")
        served = tabledap("gom_heatwaves_daily", f'&series_id="{buoy}_{depth}"')
        written = pd.read_csv(path, float_precision="round_trip")

        assert list(served["time"].str[:10]) == list(written["date"])
        assert (served["time"].str[10:] == "T12:00:00Z").all()
        written["heatwave_origin"] = written["heatwave_origin"].map(
            products.ORIGIN_FLAGS.index, na_action="ignore"
        )
        for name in products.DAILY_VARIABLES:
            assert np.array_equal(
                served[name].to_numpy(float), written[name].to_numpy(float), equal_nan=True
            ), name


def test_events_match_the_file():
    served = tabledap("gom_heatwaves_events", "station,depth,time,duration,max_intensity,category,origin")
    written = pd.read_csv(SAMPLE / f"{products.EVENTS}.csv", float_precision="round_trip")

    assert list(served["station"]) == list(written["buoy_id"])
    assert list(served["time"].str[:10]) == list(written["start_date"])
    assert served["max_intensity"].equals(written["max_intensity"])
    assert list(served["origin"].fillna(0)) == [
        products.ORIGIN_FLAGS.index(origin) if isinstance(origin, str) else 0 for origin in written["origin"]
    ]
