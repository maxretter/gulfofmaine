import dataclasses
import datetime as dt
import json
from typing import get_args

import numpy as np
import pandas as pd
import pytest

from heatwaves import origin

ONSET = dt.date(2021, 4, 14)  # of a heatwave at A01, 50 m
DAYS = pd.date_range("2020-12-01", "2021-06-30", name="date")


def days(first: int, last: int) -> pd.DatetimeIndex:
    """Days `first` to `last` from the onset, inclusive; negative is before."""
    start = pd.Timestamp(ONSET)
    return pd.date_range(start + pd.Timedelta(days=first), start + pd.Timedelta(days=last), name="date")


def daily(before: float, after: float | None = None, normal: float = 10.0) -> pd.DataFrame:
    """A frame like queries.daily's: `before` up to the onset, then `after`, against a flat normal."""
    value = pd.Series(before, index=DAYS)
    value[value.index >= pd.Timestamp(ONSET)] = before if after is None else after
    return pd.DataFrame(
        {"value": value, "climatology": normal, "threshold": normal + 1, "anomaly": value - normal}
    )


def heatwave(first: int, last: int) -> pd.Series:
    return pd.Series(1, index=days(first, last))


def record(
    salinity: float | None = 0.3,
    surface_heatwave: tuple[int, int] | None = None,
    surface: tuple[float, float] | None = (13.0, 12.0),  # 1 m before and after onset
    deep_heatwave: tuple[int, int] | None = (-20, -10),
    onsets: dict[str, int] | None = None,  # other buoys' onsets at 50 m, days from ours
) -> origin.Record:
    """A01 at 50 m warms from 9 to 10 degrees at the onset. By default, every signal says offshore:
    salty water, no heatwave at 1 m, a column that stays stratified, M01 in a heatwave at depth,
    and an onset at M01 two months before.
    """
    temperature = {
        ("A01", 50): daily(9.0, 10.0),
        ("B01", 50): daily(9.0),
        ("M01", 50): daily(9.0),
        **{("M01", depth): daily(7.0) for depth in origin.DEEP_DEPTHS},
    }
    if surface is not None:
        temperature["A01", 1] = daily(*surface)
    heatwave_days = {("A01", 50): heatwave(0, 10)}
    if surface_heatwave is not None:
        heatwave_days["A01", 1] = heatwave(*surface_heatwave)
    if deep_heatwave is not None:
        heatwave_days["M01", 100] = heatwave(*deep_heatwave)
    for buoy, first in (onsets if onsets is not None else {"M01": -60}).items():
        heatwave_days[buoy, 50] = heatwave(first, first + 6)
    return origin.Record(
        temperature=temperature,
        salinity={("A01", 50): daily(32.0 + salinity, normal=32.0)} if salinity is not None else {},
        heatwave_days=heatwave_days,
    )


def test_warm_salty_water_arriving_first_offshore_is_offshore():
    evidence = origin.judge(record(), "A01", 50, ONSET)

    assert evidence.origin == "offshore"
    assert set(evidence.votes.values()) == {"offshore"}
    assert evidence.salinity_anomaly == pytest.approx(0.3)
    assert evidence.surface_heatwave_days == 0
    assert (evidence.stratification_before, evidence.stratification_after) == (4.0, 2.0)
    assert evidence.deep_heatwave_days == 11
    # A01's own onset doesn't count for the west; B01 had data, and no onset.
    assert (evidence.offshore_onset, evidence.western_onset) == (ONSET - dt.timedelta(days=60), None)


def test_heat_mixed_down_from_a_warm_surface_is_surface():
    evidence = origin.judge(
        record(
            salinity=-0.1,
            surface_heatwave=(-20, -5),
            surface=(13.0, 10.5),
            deep_heatwave=None,
            onsets={"B01": -30, "M01": -10},
        ),
        "A01",
        50,
        ONSET,
    )

    assert evidence.origin == "surface"
    assert set(evidence.votes.values()) == {"surface"}
    assert evidence.surface_heatwave_days == 16
    assert evidence.stratification_after == 0.5
    assert evidence.deep_heatwave_days == 0  # M01 had data, and no heatwave
    assert evidence.western_onset == ONSET - dt.timedelta(days=30)


def test_signals_that_conflict_are_unclear():
    # Offshore by the column, the deep water and the onsets; surface by
    # salinity and the heatwave at 1 m.
    evidence = origin.judge(record(salinity=-0.1, surface_heatwave=(-20, -5)), "A01", 50, ONSET)

    assert list(evidence.votes.values()) == ["surface", "surface", "offshore", "offshore", "offshore"]
    assert evidence.origin == "unclear"


def test_signals_without_data_dont_vote():
    bare = origin.Record(
        temperature={("A01", 50): daily(9.0, 10.0)}, salinity={}, heatwave_days={("A01", 50): heatwave(0, 10)}
    )

    evidence = origin.judge(bare, "A01", 50, ONSET)

    assert set(evidence.votes.values()) == {None}
    assert evidence.origin == "unclear"
    assert evidence.surface_heatwave_days is None
    assert evidence.deep_heatwave_days is None
    assert evidence.western_onset is None  # its own doesn't count


def test_in_a_mixed_column_the_surface_cant_lead():
    # Winter: 1 m barely warmer than 50 m, so the column is already mixed.
    evidence = origin.judge(record(surface=(9.5, 10.2)), "A01", 50, ONSET)

    assert evidence.votes["stratification"] is None
    assert evidence.votes["surface_heatwave"] is None
    assert evidence.origin == "offshore"  # on the other three


def test_a_drifting_salinity_sensor_doesnt_vote():
    evidence = origin.judge(record(salinity=-1.5), "A01", 50, ONSET)

    assert evidence.salinity_anomaly == pytest.approx(-1.5)
    assert evidence.votes["salinity"] is None


@pytest.mark.parametrize(
    ("anomaly", "vote"),
    [(0.15, "offshore"), (0.1, None), (0.0, "surface"), (-1.0, "surface"), (-1.01, None), (None, None)],
)
def test_salinity_vote(anomaly, vote):
    assert origin.salinity_vote(anomaly) == vote


@pytest.mark.parametrize(
    ("before", "after", "vote"),
    [(4.0, 2.0, "offshore"), (4.0, 1.9, "surface"), (0.9, 0.0, None), (None, 1.0, None), (4.0, None, None)],
)
def test_stratification_vote(before, after, vote):
    assert origin.stratification_vote(before, after) == vote


def day(n: int) -> dt.date:
    return ONSET + dt.timedelta(days=n)


@pytest.mark.parametrize(
    ("offshore", "western", "observed", "vote"),
    [
        (day(-8), day(0), (True, True), "offshore"),
        (day(-7), day(0), (True, True), "surface"),  # together
        (day(0), day(-30), (True, True), "surface"),
        (day(-30), None, (True, True), "offshore"),
        (day(-30), None, (True, False), None),  # the west had no data to have an onset
        (None, day(-30), (True, True), "surface"),
        (None, day(-30), (False, True), None),
        (None, None, (True, True), None),
    ],
)
def test_onset_order_vote(offshore, western, observed, vote):
    offshore_observed, western_observed = observed
    assert (
        origin.onset_order_vote(
            offshore, western, offshore_observed=offshore_observed, western_observed=western_observed
        )
        == vote
    )


FOUR = (*origin.OFFSHORE_BUOYS, *origin.WESTERN_BUOYS)


@pytest.mark.parametrize(
    ("buoy", "offshore", "western"),
    [
        ("A01", ("N01", "M01"), ("B01",)),
        ("B01", ("N01", "M01"), ("A01",)),
        ("M01", ("N01",), ("A01", "B01")),
        ("N01", ("M01",), ("A01", "B01")),
        ("E01", ("N01", "M01"), ("A01", "B01")),  # on neither side
    ],
)
def test_the_onset_order_leaves_out_only_the_heatwaves_own_buoy(buoy, offshore, western):
    assert origin.sides(buoy) == (offshore, western)


@pytest.mark.parametrize("buoy", FOUR)
def test_a_heatwave_seen_at_no_other_buoy_casts_no_onset_order_vote(buoy):
    # Every one of the four had data; only this one had heatwaves, an earlier one too.
    alone = origin.Record(
        temperature={(other, 50): daily(9.0) for other in FOUR},
        salinity={},
        heatwave_days={(buoy, 50): pd.concat([heatwave(-60, -55), heatwave(0, 10)])},
    )

    evidence = origin.judge(alone, buoy, 50, ONSET)

    assert (evidence.offshore_onset, evidence.western_onset) == (None, None)
    assert evidence.votes["onset_order"] is None


def test_a_heatwave_still_sees_an_earlier_onset_on_its_own_side():
    evidence = origin.judge(record(onsets={"B01": -20}), "A01", 50, ONSET)

    assert (evidence.offshore_onset, evidence.western_onset) == (None, day(-20))
    assert evidence.votes["onset_order"] == "surface"  # M01 had data, and no onset


def test_its_own_buoys_data_dont_count_for_its_side():
    # At M01, after an onset at B01: with no data at N01, the offshore side couldn't have seen one.
    at_m01 = record(onsets={"B01": -20, "M01": 0})
    with_n01 = dataclasses.replace(at_m01, temperature={**at_m01.temperature, ("N01", 50): daily(9.0)})

    assert origin.judge(at_m01, "M01", 50, ONSET).votes["onset_order"] is None
    assert origin.judge(with_n01, "M01", 50, ONSET).votes["onset_order"] == "surface"


def test_the_other_side_and_buoys_on_neither_are_read_whole():
    both = record(onsets={"N01": -60, "M01": -30})

    # At A01, the offshore side is both buoys, and its first onset N01's.
    assert origin.judge(both, "A01", 50, ONSET).offshore_onset == day(-60)
    # At E01, every one of the four counts, A01's onset on the same day too.
    at_e01 = origin.judge(both, "E01", 50, ONSET)
    assert (at_e01.offshore_onset, at_e01.western_onset) == (day(-60), ONSET)
    assert at_e01.votes["onset_order"] == "offshore"


@pytest.mark.parametrize(
    ("votes", "label"),
    [
        (["offshore", "offshore", None, None, None], "offshore"),
        (["offshore", "offshore", "offshore", "surface", None], "offshore"),
        (["offshore", "offshore", "surface", None, None], "unclear"),
        (["offshore", None, None, None, None], "unclear"),
        (["surface", "surface", "surface", "offshore", "offshore"], "unclear"),
        (["surface", "surface", None, None, None], "surface"),
    ],
)
def test_a_label_needs_two_more_votes_than_the_other_side(votes, label):
    assert origin.label(votes) == label


def test_onsets_are_the_first_day_of_each_heatwave():
    heatwave_days = pd.concat([heatwave(0, 4), heatwave(8, 12)])

    assert list(origin.onsets(heatwave_days).date) == [day(0), day(8)]


def test_signals_day_by_day_over_the_evidence_window():
    signals = origin.signals(record(surface_heatwave=(-3, -1)), "A01", 50, ONSET)

    assert (signals.index[0], signals.index[-1]) == (pd.Timestamp(day(-30)), pd.Timestamp(day(14)))
    at_onset = signals.loc[pd.Timestamp(ONSET)]
    assert (at_onset["anomaly"], at_onset["salinity_anomaly"], at_onset["stratification"]) == pytest.approx(
        (0.0, 0.3, 2.0)
    )
    assert at_onset["deep_anomaly"] == -3.0
    assert signals["surface_heatwave"].sum() == 3
    assert signals["deep_heatwave"].sum() == 11


def test_signals_without_data_are_missing():
    bare = origin.Record(temperature={("A01", 50): daily(9.0, 10.0)}, salinity={}, heatwave_days={})

    signals = origin.signals(bare, "A01", 50, ONSET)

    assert signals[["salinity_anomaly", "stratification", "deep_anomaly"]].isna().all().all()
    assert not signals["surface_heatwave"].any()
    assert not signals["deep_heatwave"].any()


def test_recent_onsets_at_every_buoy_oldest_first():
    onsets = origin.recent_onsets(record(onsets={"M01": -60, "B01": -95, "E01": -30}), 50, ONSET)

    assert onsets == [("M01", day(-60)), ("E01", day(-30)), ("A01", day(0))]  # B01's is too long before


def test_a_judgment_reads_only_its_inputs_over_its_window():
    full = record()
    first, last = (pd.Timestamp(day) for day in origin.window(ONSET))

    def outside(frame: pd.DataFrame) -> pd.DataFrame:
        """The frame with every value outside the window changed."""
        changed = frame.copy()
        changed.loc[(changed.index < first) | (changed.index > last), ["value", "anomaly"]] += 5.0
        return changed

    changed = origin.Record(
        temperature={key: outside(frame) for key, frame in full.temperature.items()}
        | {("E01", 50): daily(20.0)},
        salinity={key: outside(frame) for key, frame in full.salinity.items()} | {("A01", 1): daily(35.0)},
        heatwave_days={
            **full.heatwave_days,
            ("E01", 50): heatwave(-10, -5),  # not a buoy whose onsets count
            ("M01", 50): pd.concat([heatwave(-100, -95), full.heatwave_days["M01", 50]]),
            ("A01", 1): heatwave(origin.AFTER + 1, origin.AFTER + 10),
        },
    )

    assert origin.judge(changed, "A01", 50, ONSET) == origin.judge(full, "A01", 50, ONSET)


def test_the_window_takes_in_the_day_before_the_lookback():
    # A heatwave at M01 on the lookback's first day began then, unless it was one the day before too.
    assert origin.window(ONSET) == (day(-origin.LOOKBACK - 1), day(origin.AFTER))
    begins = record(onsets={"M01": -origin.LOOKBACK})
    earlier = dataclasses.replace(
        begins,
        heatwave_days={
            **begins.heatwave_days,
            ("M01", 50): heatwave(-origin.LOOKBACK - 1, -origin.LOOKBACK + 6),
        },
    )

    assert origin.judge(begins, "A01", 50, ONSET).offshore_onset == day(-origin.LOOKBACK)
    assert origin.judge(earlier, "A01", 50, ONSET).offshore_onset is None


def test_evidence_serializes_dates_for_json():
    stored = origin.judge(record(), "A01", 50, ONSET).to_json()

    assert stored["offshore_onset"] == "2021-02-13"
    assert stored["origin"] == "offshore"
    assert stored["votes"]["onset_order"] == "offshore"


def test_evidence_reads_back_as_it_was_stored():
    # With an onset offshore, and with none.
    for buoy, around in (("A01", record()), ("E01", record(onsets={}))):
        judged = origin.judge(around, buoy, 50, ONSET)

        assert origin.Evidence.from_json(json.loads(json.dumps(judged.to_json()))) == judged


# The vote each reason a signal can give stands for.
VOTES: dict[str, dict[str, origin.Vote]] = {
    "salinity": {
        "too_few_days": None,
        "drift": None,
        "salty": "offshore",
        "fresh": "surface",
        "between": None,
    },
    "surface_heatwave": {
        "too_few_days": None,
        "heatwave": "surface",
        "stratified": "offshore",
        "too_few_days_to_compare": None,
        "mixed": None,
    },
    "stratification": {
        "too_few_days": None,
        "too_few_days_before": None,
        "too_few_days_after": None,
        "mixed": None,
        "collapsed": "surface",
        "held": "offshore",
    },
    "deep": {"too_few_days": None, "heatwave": "offshore", "no_heatwave": "surface"},
    "onset_order": {
        "offshore_first": "offshore",
        "western_first": "surface",
        "together": "surface",
        "offshore_only": "offshore",
        "western_only": "surface",
        "western_unobserved": None,
        "offshore_unobserved": None,
        "no_onsets": None,
    },
}
# Days with data, from the onset: the whole record, most often; the evidence window before onset, or from
# it; a few days before it; only long before; None for no series at all.
SPANS = [(-120, 60), (-120, 60), (-120, 60), (-30, -1), (0, 14), (-5, -1), (-95, -50), None]


def random_record(rng: np.random.Generator, buoy: str) -> origin.Record:
    """A record around a heatwave at `buoy`, 50 m, from ONSET, each series over a random span, or none."""

    def over(frame: pd.DataFrame) -> pd.DataFrame | None:
        span = SPANS[rng.integers(len(SPANS))]
        if span is None:
            return None
        first, last = (pd.Timestamp(day(each)) for each in span)
        return frame.loc[first:last]

    def heatwave_from(first: int, last: int) -> pd.Series:
        start = int(rng.integers(first, last + 1))
        return heatwave(start, start + int(rng.integers(5, 20)))

    temperature = {
        (buoy, 50): over(daily(9.0, 10.0)),
        # 1 m minus 50 m: 0.5, 2 or 4 degrees before onset, 0.2, 1.5 or 3 after.
        (buoy, 1): over(daily(rng.choice([9.5, 11.0, 13.0]), rng.choice([10.2, 11.5, 13.0]))),
        ("M01", 100): over(daily(7.0)),
        **{(other, 50): over(daily(9.0)) for other in FOUR if other != buoy},
    }
    anomaly = rng.choice([-1.5, -1.0, -0.5, 0.0, 0.1, 0.15, 0.3]) + rng.choice([0.0, 0.02])
    salinity = over(daily(32 + anomaly, normal=32.0))
    heatwave_days = {(buoy, 50): heatwave(0, 10)}
    if rng.random() < 0.5:
        heatwave_days[buoy, 1] = heatwave_from(-40, 10)
    if rng.random() < 0.5:
        heatwave_days["M01", 100] = heatwave_from(-45, 5)
    for other in (*FOUR, "E01"):
        if other != buoy and rng.random() < 0.5:
            heatwave_days[other, 50] = heatwave_from(-100, 5)
    return origin.Record(
        temperature={key: frame for key, frame in temperature.items() if frame is not None},
        salinity={(buoy, 50): salinity} if salinity is not None else {},
        heatwave_days=heatwave_days,
    )


def test_every_reason_stands_for_the_vote_judge_cast():
    assert {reason for reasons in VOTES.values() for reason in reasons} == set(get_args(origin.Reason))
    rng = np.random.default_rng(1)
    given: set[tuple[str, str]] = set()

    for _ in range(300):
        buoy = str(rng.choice([*FOUR, "E01"]))
        judged = origin.judge(random_record(rng, buoy), buoy, 50, ONSET)

        reasons = origin.explain(origin.Evidence.from_json(judged.to_json()), buoy)

        assert {signal: VOTES[signal][reason] for signal, reason in reasons.signals.items()} == judged.votes
        assert (reasons.offshore_buoys, reasons.western_buoys) == origin.sides(buoy)
        assert reasons.left_out == (buoy if buoy in FOUR else None)
        given |= set(reasons.signals.items())
    # Every reason, so none goes untested.
    assert given == {(signal, reason) for signal, reasons in VOTES.items() for reason in reasons}
