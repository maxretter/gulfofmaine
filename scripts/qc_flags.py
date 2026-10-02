"""What the quality flags drop, in every buoy dataset the app reads.

heatwaves.qc keeps a reading only if UMaine's flag ({variable}_qc) marks it
good and the QARTOD aggregate ({variable}_qc_agg) doesn't mark it suspect or
fail. This asks NERACOOS's ERDDAP, for each buoy dataset and variable, for
the distinct pairs of the two flags and how many readings (rows with a
value) have each pair, and prints them, then what the filter drops: any
pair the QARTOD flag marks suspect, readings UMaine's flag keeps but the
QARTOD flag drops, and readings either drops. One public, read-only request
per dataset and variable.

    PYTHONPATH=. uv run scripts/qc_flags.py
"""

import sys

import httpx

from heatwaves import qc
from heatwaves.config import settings
from heatwaves.erddap import Erddap, same_origin
from heatwaves.stations import SERIES, SourceName, Variable

SUSPECT = 3  # the QARTOD aggregate's flag for suspect; 4 is fail (qc.BAD_QARTOD_FLAGS)

# (UMaine's flag, the QARTOD aggregate), None where a row has none.
Pair = tuple[int | None, int | None]


def flag_counts(erddap: Erddap, dataset_id: str, variable: str) -> dict[Pair, int]:
    """Each distinct pair of a variable's two flags in a dataset, with how many of its rows have a value."""
    umaine, qartod = qc.flags(variable)
    rows = erddap.rows(dataset_id, [variable, umaine, qartod], [f'orderByCount("{umaine},{qartod}")'])
    return {(row[umaine], row[qartod]): row[variable] for row in rows}


def kept(pair: Pair) -> bool:
    """Whether qc.good_readings keeps a reading with these flags."""
    umaine, qartod = pair
    return umaine == qc.GOOD_UMAINE_FLAG and qartod not in qc.BAD_QARTOD_FLAGS


def report(counts: dict[tuple[str, str], dict[Pair, int]]) -> list[str]:
    """Each dataset and variable's pairs with their readings, then what the filter drops."""
    lines = [
        f"{dataset_id} {variable}: "
        + "; ".join(f"{pair} {readings:,}" for pair, readings in sorted(pairs.items(), key=str))
        for (dataset_id, variable), pairs in counts.items()
    ]
    suspect = [
        f"{dataset_id} {variable}"
        for (dataset_id, variable), pairs in counts.items()
        if any(qartod == SUSPECT for _, qartod in pairs)
    ]
    every = [(pair, readings) for pairs in counts.values() for pair, readings in pairs.items()]
    only_qartod = sum(
        readings
        for (umaine, qartod), readings in every
        if umaine == qc.GOOD_UMAINE_FLAG and not kept((umaine, qartod))
    )
    dropped = sum(readings for pair, readings in every if not kept(pair))
    total = sum(readings for _, readings in every)
    lines += [
        f"Marked suspect by the QARTOD flag: {', '.join(suspect) or 'none'}.",
        f"Readings UMaine's flag keeps and the QARTOD flag drops: {only_qartod:,}.",
        f"Readings either flag drops: {dropped:,} of {total:,}.",
    ]
    return lines


def flags_everywhere(erddap: Erddap) -> dict[tuple[str, str], dict[Pair, int]]:
    """flag_counts for every buoy dataset and variable the app reads."""
    datasets = sorted({spec.dataset_id for spec in SERIES if spec.source == SourceName.BUOY})
    return {
        (dataset_id, variable): flag_counts(erddap, dataset_id, variable)
        for dataset_id in datasets
        for variable in Variable
    }


def main() -> int:
    with httpx.Client(
        timeout=settings.erddap_timeout,
        headers={"User-Agent": settings.user_agent},
        follow_redirects=True,
        event_hooks={"response": [same_origin]},
    ) as client:
        counts = flags_everywhere(Erddap(settings.erddap_url, client))
    for line in report(counts):
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
