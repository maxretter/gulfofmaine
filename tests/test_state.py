"""A paused heatwave (heatwaves.state), held to what detection makes of the days after (heatwaves.hobday)."""

import datetime as dt
import itertools

import pandas as pd
import pytest

from heatwaves import hobday
from heatwaves.hobday import MAX_GAP, MIN_DURATION
from heatwaves.models import Event, Series
from heatwaves.state import SeriesState, state_of

A_HEATWAVE = "-" + "+" * MIN_DURATION  # Jun 2 to 6


def frame(days: str) -> pd.DataFrame:
    """An `align`-style frame from Jun 1, a day per character: "+" above the threshold, "-" at the normal."""
    return pd.DataFrame(
        {
            "temperature": [11.5 if day == "+" else 10.0 for day in days],
            "climatology": 10.0,
            "threshold": 11.0,
        },
        index=pd.date_range("2026-06-01", periods=len(days)),
    )


def state(days: str) -> tuple[SeriesState, list[hobday.Event]]:
    """The state on the last of `days`, from what the sync stores of them, and the heatwaves found in them."""
    found = hobday.detect_events(frame(days))
    status = hobday.latest_status(frame(days))
    series = Series(
        latest_date=status.date, days_above=status.days_above, latest_climatology=status.climatology
    )
    latest = None
    if found:
        last = found[-1]
        latest = Event(
            start_date=last.start,
            end_date=last.end,
            peak_date=last.peak,
            max_intensity=last.max_intensity,
            mean_intensity=last.mean_intensity,
            category=last.category,
        )
    return state_of(series, latest, status.date), found


def resumes(days: str, heatwave: hobday.Event) -> bool:
    """Whether the run above the threshold that ends `days`, or one from the day after, would be joined to
    `heatwave` if it went on long enough to count: the newest heatwave found would then start as it does."""
    return hobday.detect_events(frame(days + "+" * MIN_DURATION))[-1].start == heatwave.start


@pytest.mark.parametrize(
    ("after", "expected"),
    [
        ("-", "paused"),  # a day's dip
        ("--", "paused"),  # two
        ("---", "normal"),  # three, more than MAX_GAP: nothing can be joined on now
        ("-+", "paused"),  # back above after a day's dip
        ("--++++", "paused"),  # four days back above, after a two-day dip
        ("--+++++", "heatwave"),  # five: joined on
        ("---+", "above_threshold"),  # back above after three days, too late to be joined
        ("-+-", "normal"),  # a dip, a day back above, then down again: a run now starts too late
        ("-++++-", "normal"),
    ],
)
def test_a_heatwave_is_paused_while_what_follows_could_still_be_joined_to_it(after, expected):
    current, found = state(A_HEATWAVE + after)
    first = found[0]

    assert current.state == expected
    if expected in ("paused", "heatwave"):
        # The same heatwave throughout, its start unchanged.
        assert current.heatwave is not None and current.heatwave[0] == first.start == dt.date(2026, 6, 2)
        assert current.category == first.category
    else:
        assert (current.category, current.heatwave) == (None, None)


def test_paused_exactly_when_a_run_that_went_on_would_be_joined_to_the_newest_heatwave():
    wrong = []
    # Every way the days after a heatwave can go, for longer than a pause can last.
    for tail in itertools.product("+-", repeat=MAX_GAP + MIN_DURATION + 2):
        days = A_HEATWAVE + "".join(tail)
        current, found = state(days)
        if current.state == "heatwave":
            continue
        newest = found[-1]
        if resumes(days, newest):
            details = (newest.start, newest.end, newest.peak, newest.max_intensity, newest.mean_intensity)
            expected = SeriesState("paused", newest.category, details)
        else:
            expected = SeriesState("above_threshold" if days.endswith("+") else "normal", None)
        if current != expected:
            wrong.append((days, current.state))

    assert wrong == []
