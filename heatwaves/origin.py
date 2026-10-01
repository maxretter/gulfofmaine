"""A label for where the heat in a heatwave at depth may have come from.

Each heatwave at 20 and 50 m is labeled offshore when five signals read
around its onset point to warm water arriving at depth, surface when they
point to heat from the surface reaching down, and unclear when they don't
agree. Each signal votes as follows, over days counted from the onset:

    Signal (days from onset)                  Offshore                     Surface
    Salinity anomaly at the depth (-30..14)   SALTY or more                FRESH down to DRIFT
    1 m heatwave days (-30..-1)               None, 1 m MIXED warmer       Any
    1 m minus the depth (-30..-1, 0..14)      Holds at COLLAPSE or more    Falls below COLLAPSE
    M01 at 100-250 m heatwave days (-30..-1)  Any                          None
    Onsets at this depth (-90..0)             N01 or M01 first             A01 or B01 first, or together

Each signal votes one way, or not at all when its data are missing or it
can't tell. The 1 m minus the depth votes only if 1 m was at least MIXED
warmer before onset, and compares its mean from onset with its mean before.
The onsets' window runs up to and including the onset day, so it holds the
event's own onset: an event at N01 or M01 with no onset at A01 or B01 in it
votes offshore, and one at A01 or B01 with none at N01 or M01 votes surface,
as long as the other pair had data. A label needs at least MARGIN more votes
than the other side; anything closer is unclear.

The labels say which way the rules lean, not what the signals measured. In
particular:

- 1 m minus the depth reads only the difference, so the depth warming with
  1 m unchanged votes surface just as 1 m cooling does:
  stratification_vote(2.0, 0.8) is surface whichever end moved.
- M01's deep water counts only if it was in a heatwave in the 30 days
  before onset; a heatwave there that ended before that doesn't count.

These are this project's own rules of thumb, not a published or tested
method: plain rules rather than a fitted model, so every label can be
explained from its evidence.

Anomalies are against the same fixed 2003-2022 climatology as the
heatwaves. Everything here is a plain function over pandas objects, with
no database or network access, like heatwaves.hobday.
"""

import datetime as dt
from collections.abc import Collection, Mapping
from dataclasses import asdict, dataclass
from functools import cached_property
from typing import Literal

import numpy as np
import pandas as pd

Origin = Literal["offshore", "surface", "unclear"]
Vote = Literal["offshore", "surface"] | None

DEPTHS = (20, 50)  # meters: the depths whose heatwaves get a label
BEFORE = 30  # days before onset in the evidence window
AFTER = 14  # days after onset in the evidence window
LOOKBACK = 90  # days before onset searched for other buoys' onsets
MIN_DAYS = 7  # days of data a signal needs in its window to vote

SALTY = 0.15  # salinity anomaly at or above which salinity votes offshore
FRESH = 0.0  # at or below which it votes surface
# Below this, it doesn't vote: the rules take a window this fresh for a
# drifting sensor rather than water.
DRIFT = -1.0
# Degrees C: unless 1 m was at least this much warmer than the depth before onset, 1 m minus
# the depth doesn't vote, and the 1 m heatwave signal can't vote offshore.
MIXED = 1.0
COLLAPSE = 0.5  # 1 m minus the depth votes surface when it falls below this fraction of itself
TOGETHER = 7  # days: onsets this close count as together
MARGIN = 2

OFFSHORE_BUOYS = ("N01", "M01")  # the onset order's offshore side
WESTERN_BUOYS = ("A01", "B01")
DEEP_BUOY = "M01"
DEEP_DEPTHS = (100, 150, 200, 250)
SURFACE = 1  # meters

SIGNALS = ("salinity", "surface_heatwave", "stratification", "deep", "onset_order")


@dataclass(frozen=True)
class Record:
    """The stored record an origin is judged from, by buoy and depth."""

    temperature: Mapping[tuple[str, int], pd.DataFrame]  # from queries.daily
    salinity: Mapping[tuple[str, int], pd.DataFrame]
    heatwave_days: Mapping[tuple[str, int], pd.Series]  # of temperature, from queries.heatwave_days

    @cached_property
    def onsets(self) -> dict[tuple[str, int], pd.DatetimeIndex]:
        return {key: onsets(days) for key, days in self.heatwave_days.items()}


@dataclass(frozen=True)
class Evidence:
    """The signals behind an event's origin, and how each voted. None where there's no data."""

    salinity_anomaly: float | None  # at the event's depth, mean over the evidence window
    surface_heatwave_days: int | None  # at 1 m, in the 30 days before onset
    stratification_before: float | None  # 1 m minus the event's depth, degrees C, 30 days before
    stratification_after: float | None  # the same, onset to 14 days after
    deep_heatwave_days: int | None  # days M01 was in a heatwave at any of 100-250 m, 30 days before
    offshore_onset: dt.date | None  # first onset at N01 or M01 at this depth, in the 90 days to onset
    western_onset: dt.date | None  # the same at A01 or B01; either can be this event's own
    votes: dict[str, Vote]  # by signal, in SIGNALS order
    origin: Origin

    def to_json(self) -> dict:
        return {
            key: value.isoformat() if isinstance(value, dt.date) else value
            for key, value in asdict(self).items()
        }


def judge(record: Record, buoy: str, depth: int, onset: dt.date) -> Evidence:
    """Where the heat in the heatwave starting at `onset` at a buoy and depth likely came from."""
    start = pd.Timestamp(onset)
    here = record.temperature.get((buoy, depth))
    surface = record.temperature.get((buoy, SURFACE))

    salinity = _mean(record.salinity.get((buoy, depth)), "anomaly", start, -BEFORE, AFTER)

    before = after = None
    if here is not None and surface is not None:
        difference = (surface["value"] - here["value"]).to_frame("value")
        before = _mean(difference, "value", start, -BEFORE, -1)
        after = _mean(difference, "value", start, 0, AFTER)
    stratified = before is not None and before >= MIXED

    surface_days = _heatwave_days(record, [(buoy, SURFACE)], start, -BEFORE, -1)
    surface_observed = _observed(surface, start, -BEFORE, -1, MIN_DAYS)

    deep = [(DEEP_BUOY, below) for below in DEEP_DEPTHS]
    deep_days = _heatwave_days(record, deep, start, -BEFORE, -1)
    deep_observed = any(_observed(record.temperature.get(key), start, -BEFORE, -1, MIN_DAYS) for key in deep)

    offshore_onset = _first_onset(record, OFFSHORE_BUOYS, depth, start)
    western_onset = _first_onset(record, WESTERN_BUOYS, depth, start)

    votes: dict[str, Vote] = {
        "salinity": salinity_vote(salinity),
        "surface_heatwave": (
            "surface" if surface_days else "offshore" if surface_observed and stratified else None
        ),
        "stratification": stratification_vote(before, after),
        "deep": "offshore" if deep_days else "surface" if deep_observed else None,
        "onset_order": onset_order_vote(
            offshore_onset,
            western_onset,
            offshore_observed=_group_observed(record, OFFSHORE_BUOYS, depth, start),
            western_observed=_group_observed(record, WESTERN_BUOYS, depth, start),
        ),
    }
    return Evidence(
        salinity_anomaly=salinity,
        surface_heatwave_days=surface_days if surface_days or surface_observed else None,
        stratification_before=before,
        stratification_after=after,
        deep_heatwave_days=deep_days if deep_days or deep_observed else None,
        offshore_onset=offshore_onset,
        western_onset=western_onset,
        votes=votes,
        origin=label(votes.values()),
    )


def inputs(buoy: str, depth: int) -> set[tuple[str, int]]:
    """The buoys and depths whose records `judge` reads for a heatwave at this buoy and depth."""
    return {
        (buoy, depth),
        (buoy, SURFACE),
        *((DEEP_BUOY, below) for below in DEEP_DEPTHS),
        *((other, depth) for other in (*OFFSHORE_BUOYS, *WESTERN_BUOYS)),
    }


def window(onset: dt.date) -> tuple[dt.date, dt.date]:
    """The first and last days of those records that `judge` reads for a heatwave starting on `onset`.

    The day before LOOKBACK too: whether a heatwave day is an onset depends on it.
    """
    return onset - dt.timedelta(days=LOOKBACK + 1), onset + dt.timedelta(days=AFTER)


def signals(record: Record, buoy: str, depth: int, onset: dt.date) -> pd.DataFrame:
    """Each signal day by day over an event's evidence window, for charts.

    Columns: `anomaly` (temperature at the event's depth), `salinity_anomaly`,
    `stratification` (1 m minus the event's depth), `surface_anomaly` and
    `surface_heatwave` (at 1 m), `deep_anomaly` (M01's mean over the depths
    below 50 m with data) and `deep_heatwave` (at any of them). Days without
    data are NaN.
    """
    start = pd.Timestamp(onset)
    days = pd.date_range(start - pd.Timedelta(days=BEFORE), start + pd.Timedelta(days=AFTER), name="date")

    def column(frame: pd.DataFrame | None, name: str) -> pd.Series:
        return frame[name].reindex(days) if frame is not None else pd.Series(np.nan, index=days)

    def in_heatwave(keys: Collection[tuple[str, int]]) -> np.ndarray:
        found = [record.heatwave_days[key].index.to_numpy() for key in keys if key in record.heatwave_days]
        return days.isin(np.concatenate(found)) if found else np.zeros(len(days), dtype=bool)

    here = record.temperature.get((buoy, depth))
    surface = record.temperature.get((buoy, SURFACE))
    deep = [(DEEP_BUOY, below) for below in DEEP_DEPTHS]
    deep_anomalies = [column(record.temperature.get(key), "anomaly") for key in deep]
    return pd.DataFrame(
        {
            "anomaly": column(here, "anomaly"),
            "salinity_anomaly": column(record.salinity.get((buoy, depth)), "anomaly"),
            "stratification": column(surface, "value") - column(here, "value"),
            "surface_anomaly": column(surface, "anomaly"),
            "surface_heatwave": in_heatwave([(buoy, SURFACE)]),
            "deep_anomaly": pd.concat(deep_anomalies, axis=1).mean(axis=1),
            "deep_heatwave": in_heatwave(deep),
        },
        index=days,
    )


def recent_onsets(record: Record, depth: int, onset: dt.date) -> list[tuple[str, dt.date]]:
    """Every buoy's onsets at this depth in the LOOKBACK days before `onset` and on it, oldest first."""
    start = pd.Timestamp(onset)
    earliest = start - pd.Timedelta(days=LOOKBACK)
    return sorted(
        (
            (buoy, day.date())
            for (buoy, at), days in record.onsets.items()
            if at == depth
            for day in days
            if earliest <= day <= start
        ),
        key=lambda found: (found[1], found[0]),
    )


def salinity_vote(anomaly: float | None) -> Vote:
    if anomaly is None or anomaly < DRIFT:
        return None
    if anomaly >= SALTY:
        return "offshore"
    return "surface" if anomaly <= FRESH else None


def stratification_vote(before: float | None, after: float | None) -> Vote:
    """Surface if 1 m minus the depth, from onset, falls below COLLAPSE of its mean before; else offshore.

    No vote unless it was at least MIXED before. Only the difference counts,
    so the depth warming with 1 m unchanged votes surface just as 1 m cooling
    does: (2.0, 0.8) is surface whichever end moved.
    """
    if before is None or after is None or before < MIXED:
        return None
    return "surface" if after < COLLAPSE * before else "offshore"


def onset_order_vote(
    offshore: dt.date | None, western: dt.date | None, *, offshore_observed: bool, western_observed: bool
) -> Vote:
    """Offshore if N01 or M01's first onset came more than TOGETHER days before A01 or B01's, else surface.

    With an onset on one side only, the vote goes that side's way if the
    other had data to have one. Either onset can be the event's own
    (`_first_onset`).
    """
    if offshore is not None and western is not None:
        return "offshore" if (western - offshore).days > TOGETHER else "surface"
    if offshore is not None:
        return "offshore" if western_observed else None
    if western is not None:
        return "surface" if offshore_observed else None
    return None


def label(votes: Collection[Vote]) -> Origin:
    offshore = sum(vote == "offshore" for vote in votes)
    surface = sum(vote == "surface" for vote in votes)
    if offshore - surface >= MARGIN:
        return "offshore"
    if surface - offshore >= MARGIN:
        return "surface"
    return "unclear"


def onsets(heatwave_days: pd.Series) -> pd.DatetimeIndex:
    """The first day of each heatwave in a series' heatwave days."""
    days = pd.DatetimeIndex(heatwave_days.index)
    return days[~(days - pd.Timedelta(days=1)).isin(days)]


def _window(values: pd.Series, start: pd.Timestamp, first: int, last: int) -> pd.Series:
    """Days `first` to `last` from `start`, inclusive; negative is before."""
    return values.loc[start + pd.Timedelta(days=first) : start + pd.Timedelta(days=last)]


def _mean(
    frame: pd.DataFrame | None, column: str, start: pd.Timestamp, first: int, last: int
) -> float | None:
    if frame is None:
        return None
    values = _window(frame[column], start, first, last)
    return float(values.mean()) if values.count() >= MIN_DAYS else None


def _observed(frame: pd.DataFrame | None, start: pd.Timestamp, first: int, last: int, days: int) -> bool:
    return frame is not None and _window(frame["value"], start, first, last).count() >= days


def _heatwave_days(
    record: Record, keys: Collection[tuple[str, int]], start: pd.Timestamp, first: int, last: int
) -> int:
    """Days in the window on which any of these series was in a heatwave."""
    days = [
        _window(record.heatwave_days[key], start, first, last).index.to_numpy()
        for key in keys
        if key in record.heatwave_days
    ]
    return len(np.unique(np.concatenate(days))) if days else 0


def _first_onset(record: Record, buoys: Collection[str], depth: int, start: pd.Timestamp) -> dt.date | None:
    """The earliest onset at any of these buoys at this depth in the LOOKBACK days to `start`, inclusive.

    So at the event's own buoy, it can be the event's own onset.
    """
    found = [day for buoy, day in recent_onsets(record, depth, start.date()) if buoy in buoys]
    return found[0] if found else None


def _group_observed(record: Record, buoys: Collection[str], depth: int, start: pd.Timestamp) -> bool:
    """Whether any of these buoys has data at this depth for half the LOOKBACK days to `start`."""
    return any(
        _observed(record.temperature.get((buoy, depth)), start, -LOOKBACK, 0, LOOKBACK // 2) for buoy in buoys
    )
