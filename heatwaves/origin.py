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
    Other buoys' onsets, same depth (-90..0)  N01 or M01 first             A01 or B01 first, or together

Each signal votes one way, or not at all when its data are missing or it
can't tell. The 1 m minus the depth votes only if 1 m was at least MIXED
warmer before onset, and compares its mean from onset with its mean before.
The onsets' window runs up to and including the onset day. An event at one
of the four buoys is compared without its own buoy (`sides`): at A01, the
western side is B01 alone. So no onset at its own buoy counts, its own
included, and an event with no onset at the other three casts no vote. A
label needs at least MARGIN more votes than the other side; anything closer
is unclear.

The labels say which way the rules lean, not what the signals measured. In
particular:

- 1 m minus the depth reads only the difference, so the depth warming with
  1 m unchanged votes surface just as 1 m cooling does:
  stratification_vote(2.0, 0.8) is surface whichever end moved.
- M01's deep water counts only if it was in a heatwave in the 30 days
  before onset; a heatwave there that ended before that doesn't count.

These are this project's own rules of thumb, not a published or tested
method: plain rules rather than a fitted model, so every label can be
explained from its evidence. `explain` does that, signal by signal, for
the event page to put in words.

Anomalies are against the same fixed 2003-2022 climatology as the
heatwaves. Everything here is a plain function over pandas objects, with
no database or network access, like heatwaves.hobday.
"""

import datetime as dt
from collections.abc import Collection, Mapping
from dataclasses import asdict, dataclass
from functools import cached_property
from typing import Any, Literal

import numpy as np
import pandas as pd

Origin = Literal["offshore", "surface", "unclear"]
Vote = Literal["offshore", "surface"] | None
# Why a signal voted as it did, or didn't vote (`explain`), and the vote each gives:
Reason = Literal[
    "too_few_days",  # none: fewer than MIN_DAYS days of data (1 m minus the depth: in both windows)
    "too_few_days_before",  # none: 1 m minus the depth, too few before onset
    "too_few_days_after",  # none: the same from onset
    "too_few_days_to_compare",  # none: no 1 m heatwave, but too few days at 1 m and the depth together
    "salty",  # offshore: salinity SALTY or more
    "fresh",  # surface: FRESH down to DRIFT
    "between",  # none: between FRESH and SALTY
    "drift",  # none: below DRIFT
    "heatwave",  # surface at 1 m, offshore at M01's deep water
    "no_heatwave",  # surface: none at M01's deep water
    "stratified",  # offshore: no 1 m heatwave, and 1 m at least MIXED warmer than the depth
    "mixed",  # none: 1 m less than MIXED warmer than the depth before onset
    "collapsed",  # surface: 1 m minus the depth fell below COLLAPSE of its value before
    "held",  # offshore: it held at COLLAPSE or more
    "offshore_first",  # offshore: both sides had onsets, offshore's more than TOGETHER days first
    "western_first",  # surface: the western side's more than TOGETHER days first
    "together",  # surface: within TOGETHER days of each other
    "offshore_only",  # offshore: an onset offshore alone, and the western side had data
    "western_only",  # surface: an onset on the western side alone, and offshore had data
    "western_unobserved",  # none: an onset offshore alone, and too little data on the western side
    "offshore_unobserved",  # none: an onset on the western side alone, and too little data offshore
    "no_onsets",  # none: no onset on either side
]

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
    western_onset: dt.date | None  # the same at A01 or B01; neither counts the event's own buoy (`sides`)
    votes: dict[str, Vote]  # by signal, in SIGNALS order
    origin: Origin

    def to_json(self) -> dict:
        return {
            key: value.isoformat() if isinstance(value, dt.date) else value
            for key, value in asdict(self).items()
        }

    @classmethod
    def from_json(cls, stored: Mapping[str, Any]) -> Evidence:
        """The evidence `to_json` stored."""
        fields = dict(stored)
        for key in ("offshore_onset", "western_onset"):
            if fields[key] is not None:
                fields[key] = dt.date.fromisoformat(fields[key])
        return cls(**fields)


@dataclass(frozen=True)
class Reasons:
    """Why each signal behind an origin voted as it did, or didn't, and what the onset order compared."""

    signals: dict[str, Reason]  # by signal, in SIGNALS order
    offshore_buoys: tuple[str, ...]  # whose onsets the onset order compared on each side (`sides`)
    western_buoys: tuple[str, ...]
    left_out: str | None  # the event's own buoy, if it's one of those four, so on neither side


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

    offshore_buoys, western_buoys = sides(buoy)
    offshore_onset = _first_onset(record, offshore_buoys, depth, start)
    western_onset = _first_onset(record, western_buoys, depth, start)

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
            offshore_observed=_group_observed(record, offshore_buoys, depth, start),
            western_observed=_group_observed(record, western_buoys, depth, start),
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


def explain(evidence: Evidence, buoy: str) -> Reasons:
    """Why each signal in the evidence for a heatwave at `buoy` voted as it did, or didn't vote.

    Read from the evidence by the rules `judge` votes with, so a stored
    judgment is explained without judging it again. Only the onset order
    with an onset on one side alone reads its vote too: whether the other
    side had the data to have had one isn't stored.
    """
    offshore_buoys, western_buoys = sides(buoy)
    return Reasons(
        signals={
            "salinity": _salinity_reason(evidence.salinity_anomaly),
            "surface_heatwave": _surface_heatwave_reason(
                evidence.surface_heatwave_days, evidence.stratification_before
            ),
            "stratification": _stratification_reason(
                evidence.stratification_before, evidence.stratification_after
            ),
            "deep": _deep_reason(evidence.deep_heatwave_days),
            "onset_order": _onset_order_reason(
                evidence.offshore_onset, evidence.western_onset, evidence.votes["onset_order"]
            ),
        },
        offshore_buoys=offshore_buoys,
        western_buoys=western_buoys,
        left_out=buoy if buoy in (*OFFSHORE_BUOYS, *WESTERN_BUOYS) else None,
    )


def inputs(buoy: str, depth: int) -> set[tuple[str, int]]:
    """The buoys and depths whose records `judge` reads for a heatwave at this buoy and depth."""
    return {
        (buoy, depth),
        (buoy, SURFACE),
        *((DEEP_BUOY, below) for below in DEEP_DEPTHS),
        *((other, depth) for other in (*OFFSHORE_BUOYS, *WESTERN_BUOYS)),
    }


def sides(buoy: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """The offshore and western buoys whose onsets the onset order compares, for a heatwave at `buoy`.

    Its own buoy is left out of its side, so its own onset never counts: a
    heatwave seen at no other of the four casts no vote, rather than one for
    its own side by where it is.
    """
    return (
        tuple(other for other in OFFSHORE_BUOYS if other != buoy),
        tuple(other for other in WESTERN_BUOYS if other != buoy),
    )


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
    other had data to have one. Neither is ever the event's own (`sides`).
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


def _salinity_reason(anomaly: float | None) -> Reason:
    if anomaly is None:
        return "too_few_days"
    if anomaly < DRIFT:
        return "drift"
    if anomaly >= SALTY:
        return "salty"
    return "fresh" if anomaly <= FRESH else "between"


def _surface_heatwave_reason(days: int | None, before: float | None) -> Reason:
    """`before` is 1 m minus the depth before onset: without a heatwave, the vote turns on it."""
    if days is None:
        return "too_few_days"
    if days:
        return "heatwave"
    if before is None:
        return "too_few_days_to_compare"
    return "stratified" if before >= MIXED else "mixed"


def _stratification_reason(before: float | None, after: float | None) -> Reason:
    if before is None and after is None:
        return "too_few_days"
    if before is None:
        return "too_few_days_before"
    if after is None:
        return "too_few_days_after"
    if before < MIXED:
        return "mixed"
    return "collapsed" if after < COLLAPSE * before else "held"


def _deep_reason(days: int | None) -> Reason:
    if days is None:
        return "too_few_days"
    return "heatwave" if days else "no_heatwave"


def _onset_order_reason(offshore: dt.date | None, western: dt.date | None, vote: Vote) -> Reason:
    if offshore is not None and western is not None:
        lag = (western - offshore).days  # positive: offshore first
        if abs(lag) <= TOGETHER:
            return "together"
        return "offshore_first" if lag > 0 else "western_first"
    # With an onset on one side alone, the vote says whether the other side had the data to have had one.
    if offshore is not None:
        return "offshore_only" if vote else "western_unobserved"
    if western is not None:
        return "western_only" if vote else "offshore_unobserved"
    return "no_onsets"


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
    """The earliest onset at any of these buoys at this depth in the LOOKBACK days to `start`, inclusive."""
    found = [day for buoy, day in recent_onsets(record, depth, start.date()) if buoy in buoys]
    return found[0] if found else None


def _group_observed(record: Record, buoys: Collection[str], depth: int, start: pd.Timestamp) -> bool:
    """Whether any of these buoys has data at this depth for half the LOOKBACK days to `start`."""
    return any(
        _observed(record.temperature.get((buoy, depth)), start, -LOOKBACK, 0, LOOKBACK // 2) for buoy in buoys
    )
