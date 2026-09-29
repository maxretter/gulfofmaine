import datetime as dt

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
    assert (evidence.offshore_onset, evidence.western_onset) == (ONSET - dt.timedelta(days=60), ONSET)


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
    assert evidence.western_onset == ONSET  # its own; with no data offshore, that says nothing


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


def test_evidence_serializes_dates_for_json():
    stored = origin.judge(record(), "A01", 50, ONSET).to_json()

    assert stored["offshore_onset"] == "2021-02-13"
    assert stored["origin"] == "offshore"
    assert stored["votes"]["onset_order"] == "offshore"
