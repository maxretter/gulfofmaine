"""scripts/qc_flags.py, on ERDDAP responses recorded from data.neracoos.org on 2026-10-01."""

import numpy as np
import pandas as pd
import xarray as xr

from heatwaves import qc
from scripts import qc_flags
from tests.conftest import NO_MATCH, recorded_erddap

# A01 at 1 m's temperature flags, and B01 at 1 m's salinity flags, where
# QARTOD leaves UMaine's 4 not evaluated (2). Nothing for the others.
FLAGS = [
    ("/A01_ocean_001m.json?temperature,", "flags_A01_ocean_001m_temperature.json"),
    ("/B01_ocean_001m.json?salinity,", "flags_B01_ocean_001m_salinity.json"),
    ("/tabledap/", NO_MATCH),
]


def test_every_buoy_dataset_and_variable_is_asked_for_its_flag_pairs():
    requests: list[str] = []

    counts = qc_flags.flags_everywhere(recorded_erddap(FLAGS, requests))

    assert len(requests) == 50  # 25 buoy datasets, each for temperature and salinity
    assert 'orderByCount("temperature_qc,temperature_qc_agg")' in requests[0]
    assert counts["A01_ocean_001m", "temperature"] == {
        (0, 1): 371264,
        (1, 4): 0,
        (40, 4): 0,
        (99, 4): 0,
        (None, 9): 0,
        (None, None): 0,
    }
    assert counts["B01_ocean_001m", "salinity"][4, 2] == 0
    assert counts["A01_ocean_001m", "salinity"] == {}
    assert qc_flags.report(counts)[-3:] == [
        "Marked suspect by the QARTOD flag: none.",
        "Readings UMaine's flag keeps and the QARTOD flag drops: 0.",
        "Readings either flag drops: 0 of 700,328.",
    ]


def test_the_report_counts_what_the_filter_drops():
    pairs: dict[qc_flags.Pair, int] = {(0, 1): 10, (0, 3): 2, (0, 4): 1, (1, 4): 4, (None, 9): 5}
    counts = {("X01_ocean_001m", "temperature"): pairs}

    assert qc_flags.report(counts) == [
        "X01_ocean_001m temperature: (0, 1) 10; (0, 3) 2; (0, 4) 1; (1, 4) 4; (None, 9) 5",
        "Marked suspect by the QARTOD flag: X01_ocean_001m temperature.",
        "Readings UMaine's flag keeps and the QARTOD flag drops: 3.",
        "Readings either flag drops: 12 of 22.",
    ]


def test_a_pair_is_kept_as_qc_keeps_a_reading_with_it():
    pairs = [(0, 1), (0, 2), (0, 3), (0, 4), (0, 9), (0, None), (1, 1), (4, 2), (None, 9), (None, None)]
    times = pd.date_range("2026-01-01", periods=len(pairs), freq="h")
    # A missing flag is NaN in the NetCDF the sync reads.
    umaine = [np.nan if flag is None else flag for flag, _ in pairs]
    qartod = [np.nan if flag is None else flag for _, flag in pairs]
    raw = xr.Dataset(
        {
            "time": ("row", times),
            "temperature": ("row", np.ones(len(pairs))),
            "temperature_qc": ("row", umaine),
            "temperature_qc_agg": ("row", qartod),
        }
    )

    kept = qc.good_readings(raw).index

    assert [qc_flags.kept(pair) for pair in pairs] == [time in kept for time in times]
