"""Compare this app's heatwave detection with the reference implementation.

Downloads buoy data from NERACOOS ERDDAP and Eric Oliver's marineHeatWaves
module (the implementation accompanying Hobday et al. 2016, pinned to a
commit), runs both on the same daily series and reports any difference in
the detected events.

    uv run --with scipy scripts/compare_with_reference.py A01_ocean_001m B01_ocean_050m

marineHeatWaves predates NumPy 2, so two one-line compatibility fixes are
applied to the downloaded copy before it's imported; the algorithm is
untouched.
"""

import importlib.util
import sys
import tempfile
from pathlib import Path

import httpx
import numpy as np
import pandas as pd

from heatwaves import hobday, qc
from heatwaves.erddap import Erddap
from heatwaves.stations import BASELINE

REFERENCE_URL = (
    "https://raw.githubusercontent.com/ecjoliver/marineHeatWaves/"
    "d7292bf08ade0af213fa760b0d7e4adfe5f52894/marineHeatWaves.py"
)
NUMPY_2_FIXES = [
    ("np.NaN", "np.nan"),
    (
        "doy[tt] = doy_leapYear[(month_leapYear == month[tt]) * (day_leapYear == day[tt])]",
        "doy[tt] = doy_leapYear[(month_leapYear == month[tt]) * (day_leapYear == day[tt])][0]",
    ),
]


def load_reference(client: httpx.Client, directory: Path):
    source = client.get(REFERENCE_URL).raise_for_status().text
    for old, new in NUMPY_2_FIXES:
        if old not in source:
            raise RuntimeError(f"Reference source changed; can't apply fix for {old!r}")
        source = source.replace(old, new)
    path = directory / "marineHeatWaves.py"
    path.write_text(source)
    spec = importlib.util.spec_from_file_location("marineHeatWaves", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def compare(erddap: Erddap, reference, dataset_id: str) -> bool:
    raw = erddap.dataset(dataset_id, qc.columns(["temperature"]))
    if raw is None:
        raise ValueError(f"{dataset_id} has no data")
    daily = qc.daily_means(qc.good_readings(raw, "temperature"))["value"]

    analysis = hobday.analyse(daily, BASELINE)
    ours = {(e.start, e.end, e.category) for e in analysis.events}

    # The reference needs its climatology period inside the series, so a record
    # shorter than the baseline (N01's, 2004-2021) is padded with missing days.
    first = min(daily.index.min(), pd.Timestamp(f"{BASELINE[0]}-01-01"))
    last = max(daily.index.max(), pd.Timestamp(f"{BASELINE[1]}-12-31"))
    days = pd.date_range(first, last, freq="D")
    ordinals = np.array([day.toordinal() for day in days.date])
    found, clim = reference.detect(
        ordinals,
        daily.reindex(days).to_numpy(),
        climatologyPeriod=list(BASELINE),
        maxPadLength=hobday.MAX_PAD,
    )
    names = {name: number for number, name in hobday.CATEGORIES.items()}
    theirs = {
        (pd.Timestamp.fromordinal(int(s)).date(), pd.Timestamp.fromordinal(int(e)).date(), names[c])
        for s, e, c in zip(found["time_start"], found["time_end"], found["category"], strict=True)
    }

    thresholds = pd.Series(clim["thresh"], index=days).reindex(analysis.frame.index)
    threshold_gap = np.nanmax(np.abs(thresholds - analysis.frame["threshold"]))
    print(
        f"{dataset_id}: {len(ours)} events here, {len(theirs)} in the reference; "
        f"thresholds agree to {threshold_gap:.3f} °C"
    )
    for label, events in (("only here", ours - theirs), ("only in reference", theirs - ours)):
        for event in sorted(events):
            print(f"  {label}: {event[0]} to {event[1]}, category {event[2]}")
    return ours == theirs


def main(dataset_ids: list[str]) -> int:
    with httpx.Client(timeout=120, follow_redirects=True) as client, tempfile.TemporaryDirectory() as tmp:
        reference = load_reference(client, Path(tmp))
        erddap = Erddap("https://data.neracoos.org/erddap", client)
        results = [compare(erddap, reference, dataset_id) for dataset_id in dataset_ids]
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or ["A01_ocean_001m", "B01_ocean_050m", "I01_ocean_020m"]))
