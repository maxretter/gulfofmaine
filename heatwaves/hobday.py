"""Marine heatwave detection, following Hobday et al. (2016).

A marine heatwave is a spell of at least five days on which the daily mean
temperature is above a seasonally varying threshold: the 90th percentile of
temperatures for that time of year over a fixed baseline period. Events
separated by two days or fewer are joined into one. Each event is categorized
(Hobday et al. 2018) by how many multiples of the threshold's distance above
the climatology its peak reached: 1 Moderate, 2 Strong, 3 Severe, 4 Extreme.

Everything here is a plain function over xarray and pandas objects, with no
database or network access. The parameters are the defaults of the reference
implementation, https://github.com/ecjoliver/marineHeatWaves, apart from gap
filling (MAX_PAD), which the reference leaves unbounded by default.

References:
    Hobday et al. (2016), A hierarchical approach to defining marine
    heatwaves. Progress in Oceanography 141. doi:10.1016/j.pocean.2015.12.014
    Hobday et al. (2018), Categorizing and naming marine heatwaves.
    Oceanography 31(2). doi:10.5670/oceanog.2018.205
"""

import datetime as dt
from dataclasses import dataclass

import numpy as np
import pandas as pd
import xarray as xr

WINDOW_HALF_WIDTH = 5  # days either side of each calendar day pooled into its statistics
SMOOTH_WIDTH = 31  # days in the running mean applied to the climatology and threshold
PERCENTILE = 0.9
MIN_DURATION = 5  # consecutive days above the threshold that make an event
MAX_GAP = 2  # events this many days apart or closer are joined
MAX_PAD = 2  # missing-data gaps this long or shorter are interpolated

CATEGORIES = {1: "Moderate", 2: "Strong", 3: "Severe", 4: "Extreme"}

# Days of the year on a 366-day calendar, where Feb 29 always has a slot.
DAYS_OF_YEAR = np.arange(1, 367)
FEB_29 = 60


class InsufficientData(ValueError):
    """The baseline period has too few observations for a climatology."""


@dataclass(frozen=True)
class Event:
    start: dt.date
    end: dt.date  # inclusive
    peak: dt.date
    max_intensity: float  # degrees C above the climatology on the peak day
    mean_intensity: float
    category: int  # 1 Moderate to 4 Extreme

    @property
    def duration(self) -> int:
        return (self.end - self.start).days + 1


@dataclass(frozen=True)
class Status:
    """Conditions on the most recent day with data."""

    date: dt.date
    temperature: float
    climatology: float
    threshold: float
    days_above: int  # consecutive days above the threshold, ending on `date`


@dataclass(frozen=True)
class Analysis:
    climatology: xr.Dataset  # from `climatology`
    frame: pd.DataFrame  # from `align`
    events: list[Event]
    status: Status


def analyse(temperature: pd.Series, baseline: tuple[int, int]) -> Analysis:
    """The whole method in one call: climatology, aligned frame, events and latest status.

    Raises InsufficientData if the baseline has too little data.
    """
    stats = climatology(temperature, baseline)
    frame = align(temperature, stats)
    return Analysis(stats, frame, detect_events(frame), latest_status(frame))


def day_of_year(days: pd.DatetimeIndex) -> np.ndarray:
    """Day of year on a 366-day calendar: Mar 1 is always 61, Feb 29 is 60."""
    after_skipped_leap_day = ~days.is_leap_year & (days.month > 2)
    return days.dayofyear.to_numpy() + after_skipped_leap_day


def climatology(temperature: pd.Series, baseline: tuple[int, int]) -> xr.Dataset:
    """Seasonal mean and heatwave threshold for each day of a 366-day year.

    `temperature` is a daily series. For each calendar day, every baseline
    value within WINDOW_HALF_WIDTH days of it is pooled across all baseline
    years; the pool's mean and 90th percentile are then smoothed with a
    SMOOTH_WIDTH-day running mean that wraps around the new year.

    Returns a Dataset with `mean` and `threshold` along a `day_of_year`
    dimension (1-366).
    """
    first_year, last_year = baseline
    days = pd.date_range(f"{first_year}-01-01", f"{last_year}-12-31", freq="D", name="time")
    # Short gaps are filled before pooling, as the reference does.
    filled = fill_short_gaps(temperature.asfreq("D"), MAX_PAD).reindex(days)
    values = xr.DataArray.from_series(filled.rename_axis("time"))
    if values.count() < days.size / 2:
        raise InsufficientData(
            f"{int(values.count())} of {days.size} baseline days have data; at least half are needed"
        )

    # Pool neighbours by position in the time series, as the reference
    # implementation does, so windows cross year boundaries within the
    # baseline and are cut short at its two ends.
    windows = (
        values.rolling(time=2 * WINDOW_HALF_WIDTH + 1, center=True)
        .construct("window")
        .assign_coords(day_of_year=("time", day_of_year(days)))
        .groupby("day_of_year")
    )
    stats = xr.Dataset(
        {
            "mean": windows.mean(dim=["time", "window"]),
            "threshold": windows.quantile(PERCENTILE, dim=["time", "window"]).drop_vars("quantile"),
        }
    )

    # Only leap years fill the Feb 29 pool, so like the reference we take the
    # average of its neighbours instead.
    for name in stats.data_vars:
        stats[name].loc[{"day_of_year": FEB_29}] = (
            stats[name].sel(day_of_year=FEB_29 - 1) + stats[name].sel(day_of_year=FEB_29 + 1)
        ) / 2

    smoothed = xr.apply_ufunc(
        _circular_running_mean,
        stats,
        input_core_dims=[["day_of_year"]],
        output_core_dims=[["day_of_year"]],
        kwargs={"width": SMOOTH_WIDTH},
    )
    if smoothed["threshold"].isnull().any():
        raise InsufficientData("The baseline leaves some days of the year without a threshold")
    return smoothed


def _circular_running_mean(values: np.ndarray, width: int) -> np.ndarray:
    half = width // 2
    wrapped = np.concatenate([values[-half:], values, values[:half]])
    return np.convolve(wrapped, np.ones(width) / width, mode="valid")


def align(temperature: pd.Series, stats: xr.Dataset) -> pd.DataFrame:
    """A continuous daily frame of temperature, climatology and threshold.

    Spans the first to the last observation. Gaps of MAX_PAD days or fewer are
    interpolated; longer ones stay missing, and so can't be part of an event.
    """
    days = pd.date_range(temperature.index.min(), temperature.index.max(), freq="D")
    by_day = stats.sel(day_of_year=day_of_year(days))
    return pd.DataFrame(
        {
            "temperature": fill_short_gaps(temperature.reindex(days), MAX_PAD),
            "climatology": by_day["mean"].to_numpy(),
            "threshold": by_day["threshold"].to_numpy(),
        },
        index=days,
    )


def fill_short_gaps(series: pd.Series, max_length: int) -> pd.Series:
    """Linearly interpolate runs of missing values no longer than `max_length`.

    Longer runs are left entirely missing. (pandas' `interpolate(limit=...)`
    would instead fill the first few values of every long gap.)
    """
    missing = series.isna()
    run_ids = (missing != missing.shift()).cumsum()
    run_lengths = missing.groupby(run_ids).transform("size")
    fillable = missing & (run_lengths <= max_length)
    return series.where(~fillable, series.interpolate(method="time", limit_area="inside"))


def detect_events(frame: pd.DataFrame) -> list[Event]:
    """Marine heatwaves in a frame from `align`, oldest first."""
    above = (frame["temperature"] > frame["threshold"]).to_numpy()
    spans = [(start, end) for start, end in _true_runs(above) if end - start + 1 >= MIN_DURATION]

    joined: list[tuple[int, int]] = []
    for start, end in spans:
        if joined and start - joined[-1][1] - 1 <= MAX_GAP:
            joined[-1] = (joined[-1][0], end)
        else:
            joined.append((start, end))

    return [_describe(frame.iloc[start : end + 1]) for start, end in joined]


def _true_runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """(first, last) index of each run of consecutive True values."""
    edges = np.flatnonzero(np.diff(np.concatenate([[0], mask.astype(int), [0]])))
    return [(int(start), int(end) - 1) for start, end in zip(edges[::2], edges[1::2], strict=True)]


def _describe(days: pd.DataFrame) -> Event:
    anomaly = days["temperature"] - days["climatology"]
    peak = anomaly.idxmax()
    # The category comes from the day furthest above normal in multiples of
    # the threshold's distance, which needn't be the warmest day relative to
    # normal: the threshold's distance changes through the year.
    multiples = anomaly / (days["threshold"] - days["climatology"])
    category = int(np.clip(np.floor(multiples.max()), 1, 4))
    return Event(
        start=days.index[0].date(),
        end=days.index[-1].date(),
        peak=peak.date(),
        max_intensity=float(anomaly[peak]),
        mean_intensity=float(anomaly.mean()),
        category=category,
    )


def latest_status(frame: pd.DataFrame) -> Status:
    """Conditions on the last day of a frame from `align`."""
    above = (frame["temperature"] > frame["threshold"]).to_numpy()
    days_above = len(above) - int(np.flatnonzero(~above)[-1]) - 1 if not above.all() else len(above)
    last = frame.iloc[-1]
    return Status(
        date=frame.index[-1].date(),
        temperature=float(last["temperature"]),
        climatology=float(last["climatology"]),
        threshold=float(last["threshold"]),
        days_above=days_above,
    )
