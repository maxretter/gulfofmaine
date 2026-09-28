"""Where series come from: one fetcher per source.

A source fetches what changed for the series at one buoy and depth, all
their variables in one request, and returns daily means over a span of days.
Storing them and recomputing heatwaves is the same for every source
(heatwaves.sync).
"""

import datetime as dt
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

import pandas as pd

from heatwaves import qc
from heatwaves.erddap import Erddap, format_time, parse_time
from heatwaves.models import Series


@dataclass(frozen=True)
class Download:
    first_day: dt.date
    last_day: dt.date  # inclusive; every stored day in the span is replaced
    daily: dict[str, pd.DataFrame]  # by variable, as from qc.daily_means
    modified_through: dt.datetime  # where the next fetch starts


class Source(Protocol):
    def fetch(self, series: Sequence[Series]) -> Download | None:
        """What changed since the series' `modified_through`, or None if nothing did.

        `series` share a buoy, depth, source and dataset, and differ only in variable.
        """
        ...


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

    def fetch(self, series: Sequence[Series]) -> Download | None:
        dataset_id = series[0].dataset_id
        stamps = [s.modified_through for s in series if s.modified_through is not None]
        # A series new to this dataset has no stamp, so the whole dataset is read.
        seen = min(stamps) if len(stamps) == len(series) else None
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

        variables = [s.variable for s in series]
        raw = self.erddap.dataset(
            dataset_id,
            qc.columns(variables),
            [f"time>={format_time(first_day)}", f"time<{format_time(last_day + dt.timedelta(days=1))}"],
        )
        empty = pd.DataFrame(columns=["value", "hours"])
        daily = {v: qc.daily_means(raw, v) if raw is not None else empty for v in variables}
        return Download(first_day, last_day, daily, modified_through)
