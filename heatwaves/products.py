"""The record as files for others to use: CF NetCDF and CSV, ready for ERDDAP.

    python -m heatwaves.products   # write every product to PRODUCTS_DIR

Two products, each as NetCDF and as CSV:

- Daily series, one file per buoy and depth (daily/A01_heatwaves_020m.nc):
  temperature with its normal, heatwave threshold, anomaly and the category
  of the heatwave each day belongs to, and at 20 and 50 m where that
  heatwave's heat came from; salinity with its normal and anomaly; and the
  satellite's sea surface temperature at the buoy, treated like the buoy's
  temperature. Each file is one CF time series (featureType timeSeries), so
  ERDDAP's EDDTableFromNcCFFiles serves them all as one dataset (erddap/).
- Events, every heatwave at the buoys (gom_heatwaves_events.nc): one CF
  point per heatwave, at its buoy and depth on its first day. The CSV has
  the columns of /api/events.

Values come from the same reads as the JSON API (heatwaves.queries), so the
files and the API can't disagree. The sync job rewrites every product after
each change, replacing each file whole, so a reader never sees half of one.
"""

import argparse
import datetime as dt
import logging
import os
import sys
import tempfile
from collections.abc import Callable, Hashable
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Literal

import numpy as np
import pandas as pd
import xarray as xr
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from heatwaves import hobday, origin, qc, queries
from heatwaves.hobday import CATEGORIES
from heatwaves.models import Buoy, DailyMean, Event, Series
from heatwaves.stations import BASELINE, OISST, OISST_PRELIMINARY

log = logging.getLogger(__name__)

REPOSITORY = "https://github.com/maxretter/gulfofmaine"
NERACOOS_ERDDAP = "https://data.neracoos.org/erddap"
COASTWATCH_ERDDAP = "https://coastwatch.pfeg.noaa.gov/erddap"

DAILY = "daily"  # the subdirectory holding the daily series
EVENTS = "gom_heatwaves_events"
Format = Literal["nc", "csv"]
FORMATS: tuple[Format, ...] = ("nc", "csv")

# Flags, as CF flag_values and flag_meanings: each meaning's value is its position.
CATEGORY_FLAGS = ["none", *(name.lower() for name in CATEGORIES.values())]
ORIGIN_FLAGS = ["none", "offshore", "surface", "unclear"]
FILL = -127  # netCDF's default fill value for a byte

ON_SCALE = {"units": "degree_Celsius", "units_metadata": "temperature: on_scale"}
DIFFERENCE = {"units": "degree_Celsius", "units_metadata": "temperature: difference"}

WINDOW = 2 * hobday.WINDOW_HALF_WIDTH + 1
NORMAL = (
    f"The mean for the day of year over {BASELINE[0]}-{BASELINE[1]}, from the days with data, pooled over "
    f"a window of {WINDOW} days and smoothed with a {hobday.SMOOTH_WIDTH}-day running mean "
    "(Hobday et al. 2016)."
)
THRESHOLD = (
    f"The {hobday.PERCENTILE * 100:.0f}th percentile for the day of year over {BASELINE[0]}-{BASELINE[1]}, "
    "pooled and smoothed like the normal. A marine heatwave is at least "
    f"{hobday.MIN_DURATION} days above it (Hobday et al. 2016)."
)
DAILY_MEAN = (
    "The mean of hourly means of the readings that UMaine's flag marks good and the QARTOD aggregate "
    f"flag doesn't mark suspect or fail; days with fewer than {qc.MIN_HOURS} hours of data are missing."
)
CATEGORY = (
    "The category of the heatwave the day belongs to (Hobday et al. 2018): the most multiples of the "
    "threshold's distance above normal it reached on any day, which needn't be the peak day. Set on "
    f"every day of it, including gaps of up to {hobday.MAX_PAD} days that detection filled in. "
    "Missing on days that are neither in a heatwave nor observed."
)


def _flags(meanings: list[str], first: int = 0) -> dict:
    return {
        "flag_values": np.arange(first, len(meanings), dtype=np.int8),
        "flag_meanings": " ".join(meanings[first:]),
    }


# Every variable of a daily series file, in order, with its CF and ACDD attributes.
DAILY_VARIABLES: dict[str, dict] = {
    "temperature": {
        "standard_name": "sea_water_temperature",
        "long_name": "Sea water temperature, daily mean",
        **ON_SCALE,
        "cell_methods": "time: mean",
        "ancillary_variables": "temperature_hours",
        "coverage_content_type": "physicalMeasurement",
        "comment": DAILY_MEAN,
    },
    "temperature_hours": {
        "long_name": "Hours of the day with temperature data",
        "units": "hours",
        "coverage_content_type": "qualityInformation",
    },
    "temperature_climatology": {
        "long_name": "Normal sea water temperature for the day of year",
        **ON_SCALE,
        "coverage_content_type": "referenceInformation",
        "comment": NORMAL,
    },
    "temperature_threshold": {
        "long_name": "Marine heatwave threshold",
        **ON_SCALE,
        "coverage_content_type": "referenceInformation",
        "comment": THRESHOLD,
    },
    "temperature_anomaly": {
        "standard_name": "sea_water_temperature_anomaly",
        "long_name": "Sea water temperature above normal",
        **DIFFERENCE,
        "coverage_content_type": "physicalMeasurement",
    },
    "heatwave_category": {
        "long_name": "Marine heatwave category",
        **_flags(CATEGORY_FLAGS),
        "coverage_content_type": "thematicClassification",
        "comment": CATEGORY,
    },
    "heatwave_origin": {
        "long_name": "Origin label of the marine heatwave",
        **_flags(ORIGIN_FLAGS),
        "coverage_content_type": "thematicClassification",
        "comment": (
            "Offshore when five signals around the heatwave's onset point to warm water arriving at depth, "
            "surface when they point to heat from the surface reaching down, unclear when they don't agree: "
            "this project's own rules of thumb, not a published method. Judged only at "
            f"{' and '.join(map(str, origin.DEPTHS))} m, and missing at other depths. See {REPOSITORY}."
        ),
    },
    "salinity": {
        "standard_name": "sea_water_practical_salinity",
        "long_name": "Practical salinity, daily mean",
        "units": "1",
        "cell_methods": "time: mean",
        "ancillary_variables": "salinity_hours",
        "coverage_content_type": "physicalMeasurement",
        "comment": DAILY_MEAN,
    },
    "salinity_hours": {
        "long_name": "Hours of the day with salinity data",
        "units": "hours",
        "coverage_content_type": "qualityInformation",
    },
    "salinity_climatology": {
        "long_name": "Normal practical salinity for the day of year",
        "units": "1",
        "coverage_content_type": "referenceInformation",
        "comment": NORMAL,
    },
    "salinity_anomaly": {
        "long_name": "Practical salinity above normal",
        "units": "1",
        "coverage_content_type": "physicalMeasurement",
    },
    "satellite_temperature": {
        "standard_name": "sea_surface_temperature",
        "long_name": "Sea surface temperature from NOAA OISST v2.1 at the buoy",
        **ON_SCALE,
        "coverage_content_type": "physicalMeasurement",
        "comment": (
            "The daily analysis in the nearest quarter-degree cell with data (satellite_latitude, "
            "satellite_longitude): the final product where it exists, else the preliminary one. "
            "The same at every depth of a buoy."
        ),
    },
    "satellite_climatology": {
        "long_name": "Normal sea surface temperature for the day of year, from OISST",
        **ON_SCALE,
        "coverage_content_type": "referenceInformation",
        "comment": NORMAL,
    },
    "satellite_threshold": {
        "long_name": "Marine heatwave threshold for the satellite's sea surface temperature",
        **ON_SCALE,
        "coverage_content_type": "referenceInformation",
        "comment": THRESHOLD,
    },
    "satellite_anomaly": {
        "long_name": "Satellite sea surface temperature above normal",
        **DIFFERENCE,
        "coverage_content_type": "physicalMeasurement",
    },
    "satellite_heatwave_category": {
        "long_name": "Marine heatwave category at the surface, from OISST",
        **_flags(CATEGORY_FLAGS),
        "coverage_content_type": "thematicClassification",
        "comment": CATEGORY,
    },
}
FLAG_VARIABLES = {"heatwave_category", "heatwave_origin", "satellite_heatwave_category"}
BYTE_VARIABLES = FLAG_VARIABLES | {"temperature_hours", "salinity_hours", "category", "origin"}

# Where each series' columns from queries.daily go in a daily table.
TEMPERATURE_COLUMNS = {
    "value": "temperature",
    "climatology": "temperature_climatology",
    "threshold": "temperature_threshold",
    "anomaly": "temperature_anomaly",
}
SALINITY_COLUMNS = {"value": "salinity", "climatology": "salinity_climatology", "anomaly": "salinity_anomaly"}
SATELLITE_COLUMNS = {
    "value": "satellite_temperature",
    "climatology": "satellite_climatology",
    "threshold": "satellite_threshold",
    "anomaly": "satellite_anomaly",
}

EVENT_VARIABLES: dict[str, dict] = {
    "end_time": {
        "long_name": "Last day of the heatwave",
        "units_metadata": "leap_seconds: none",
        "coverage_content_type": "referenceInformation",
    },
    "peak_time": {
        "long_name": "Day furthest above normal",
        "units_metadata": "leap_seconds: none",
        "coverage_content_type": "referenceInformation",
    },
    "duration": {
        "long_name": "Duration",
        "units": "days",
        "coverage_content_type": "referenceInformation",
    },
    "max_intensity": {
        "long_name": "Temperature above normal on the peak day",
        **DIFFERENCE,
        "coverage_content_type": "physicalMeasurement",
    },
    "mean_intensity": {
        "long_name": "Mean temperature above normal over the heatwave",
        **DIFFERENCE,
        "coverage_content_type": "physicalMeasurement",
    },
    "category": {
        "long_name": "Marine heatwave category",
        **_flags(CATEGORY_FLAGS, first=1),
        "coverage_content_type": "thematicClassification",
        "comment": "From the day furthest above normal in multiples of the threshold's distance above it "
        "(Hobday et al. 2018).",
    },
    "origin": DAILY_VARIABLES["heatwave_origin"] | _flags(ORIGIN_FLAGS, first=1),
}

TIME = {
    "standard_name": "time",
    "long_name": "Time",
    "axis": "T",
    "units_metadata": "leap_seconds: none",
    "comment": "The middle of the UTC day. Daily values are means over the whole day.",
}
REFERENCE = {"coverage_content_type": "referenceInformation"}
TIME_ENCODING = {"units": "days since 1970-01-01 00:00:00", "calendar": "standard", "dtype": "float64"}
LATITUDE = {"standard_name": "latitude", "long_name": "Latitude", "units": "degrees_north", "axis": "Y"}
LONGITUDE = {"standard_name": "longitude", "long_name": "Longitude", "units": "degrees_east", "axis": "X"}
DEPTH = {"standard_name": "depth", "long_name": "Depth", "units": "m", "positive": "down", "axis": "Z"}

GLOBAL = {
    "Conventions": "CF-1.11, ACDD-1.3",
    "standard_name_vocabulary": "CF Standard Name Table v93",
    "naming_authority": "com.github.maxretter",
    "keywords": (
        "Earth Science > Oceans > Ocean Temperature > Water Temperature, "
        "Earth Science > Oceans > Ocean Temperature > Sea Surface Temperature, "
        "Earth Science > Oceans > Salinity/Density > Salinity, marine heatwaves, Gulf of Maine"
    ),
    "keywords_vocabulary": "GCMD Science Keywords",
    "creator_name": "Max Retter",
    "creator_type": "person",
    "creator_url": REPOSITORY,
    "publisher_name": "Max Retter",
    "publisher_type": "person",
    "publisher_url": REPOSITORY,
    "contributor_name": (
        "University of Maine Physical Oceanography Group, NERACOOS, NOAA NCEI, NOAA CoastWatch"
    ),
    "contributor_role": "originator, distributor, originator, distributor",
    "acknowledgement": (
        "Buoys operated by the University of Maine Physical Oceanography Group (PhOG) are funded in part "
        "through the National Oceanic and Atmospheric Administration (NOAA) as a Regional Association "
        "within the U.S. Integrated Ocean Observing System (IOOS). NOAA OISST v2.1 is produced by NOAA "
        "NCEI and served by NOAA CoastWatch."
    ),
    "license": (
        "Derived from University of Maine buoy data served by NERACOOS, and from NOAA OISST. As for the "
        "buoy data: the data may be used and redistributed for free but is not intended for legal use, "
        "since it may contain inaccuracies. No warranty is made for its accuracy, completeness or "
        "usefulness."
    ),
    "references": (
        "Hobday et al. (2016), doi:10.1016/j.pocean.2015.12.014; "
        "Hobday et al. (2018), doi:10.5670/oceanog.2018.205; "
        f"Huang et al. (2021), doi:10.1175/JCLI-D-20-0166.1; {REPOSITORY}"
    ),
    "project": "Gulf of Maine heatwaves",
    "processing_level": "Daily means of quality-controlled observations, with derived heatwave statistics",
    "platform": "moored_buoy",
    "platform_vocabulary": "https://mmisw.org/ont/ioos/platform",
    "sea_name": "Gulf of Maine",
    "metadata_link": REPOSITORY,
    "comment": (
        "Derived data: daily means and heatwave statistics computed from the source datasets, not a primary "
        "record. The detection is validated against the marineHeatWaves reference implementation; see "
        f"{REPOSITORY}#readme."
    ),
    "geospatial_bounds_crs": "EPSG:4326",
    "geospatial_bounds_vertical_crs": "EPSG:5831",  # depth below mean sea level
    "geospatial_lat_units": "degrees_north",
    "geospatial_lon_units": "degrees_east",
    "geospatial_vertical_units": "m",
    "geospatial_vertical_positive": "down",
}


@dataclass(frozen=True)
class Product:
    """One product file on disk, for listing."""

    name: str  # file name, e.g. A01_heatwaves_020m.nc
    buoy_id: str | None  # None for the events table
    depth: int | None
    format: Format
    path: Path

    @property
    def size(self) -> int:
        return self.path.stat().st_size

    @property
    def modified(self) -> dt.datetime:
        return dt.datetime.fromtimestamp(self.path.stat().st_mtime, dt.UTC)


def daily_name(buoy_id: str, depth: int) -> str:
    """A daily series' file name without its extension, after NERACOOS's A01_ocean_020m."""
    return f"{buoy_id}_heatwaves_{depth:03d}m"


def daily_path(directory: Path, buoy_id: str, depth: int, format: Format) -> Path:
    return directory / DAILY / f"{daily_name(buoy_id, depth)}.{format}"


def events_path(directory: Path, format: Format) -> Path:
    return directory / f"{EVENTS}.{format}"


def listing(directory: Path) -> list[Product]:
    """Every product file in `directory`: the daily series by buoy and depth, then the events."""
    found = []
    for format in FORMATS:
        for path in (directory / DAILY).glob(f"*_heatwaves_*m.{format}"):
            buoy_id, _, depth = path.stem.split("_")
            found.append(Product(path.name, buoy_id, int(depth.removesuffix("m")), format, path))
        if (path := events_path(directory, format)).exists():
            found.append(Product(path.name, None, None, format, path))
    return sorted(found, key=lambda each: (each.buoy_id or "~", each.depth or 0, FORMATS.index(each.format)))


def daily_table(session: Session, buoy: Buoy, depth: int) -> pd.DataFrame | None:
    """A buoy depth's daily series, one column per variable of DAILY_VARIABLES, indexed by day.

    Every day from the first to the last with temperature or salinity has a
    row. None if the depth has no data yet.
    """
    series = {
        (each.variable, each.source): each
        for each in session.scalars(
            select(Series).where(
                Series.buoy_id == buoy.id,
                (Series.depth == depth) | (Series.source == "satellite"),
                Series.variable.in_(["temperature", "salinity"]),
            )
        )
    }
    at_depth = [each.id for key, each in series.items() if key[1] == "buoy"]
    first, last = session.execute(
        select(func.min(DailyMean.date), func.max(DailyMean.date)).where(DailyMean.series_id.in_(at_depth))
    ).one()
    if first is None:
        return None
    days = pd.date_range(first, last, name="date")

    temperature = series.get(("temperature", "buoy"))
    salinity = series.get(("salinity", "buoy"))
    satellite = series.get(("temperature", "satellite"))
    table = pd.DataFrame(index=days)
    for each, names, hours in (
        (temperature, TEMPERATURE_COLUMNS, "temperature_hours"),
        (salinity, SALINITY_COLUMNS, "salinity_hours"),
        (satellite, SATELLITE_COLUMNS, None),
    ):
        frame = _daily(session, each, days)
        for column, name in names.items():
            table[name] = frame[column]
        if hours is not None:
            table[hours] = _column(session, each, DailyMean.hours, days)

    heatwave_days = queries.heatwave_days(session, [each.id for each in (temperature, satellite) if each])
    for name, each, values in (
        ("heatwave_category", temperature, "temperature"),
        ("satellite_heatwave_category", satellite, "satellite_temperature"),
    ):
        table[name] = _category(heatwave_days[each.id] if each else None, table[values])
    table["heatwave_origin"] = (
        _origin(session, temperature, table["heatwave_category"])
        if temperature is not None and depth in origin.DEPTHS
        else np.nan
    )
    return table[list(DAILY_VARIABLES)]


def _daily(session: Session, series: Series | None, days: pd.DatetimeIndex) -> pd.DataFrame:
    """queries.daily over `days`; without a climatology yet, the values alone."""
    frame = queries.daily(session, series.id, days[0].date(), days[-1].date()) if series else None
    if frame is not None:
        return frame
    frame = pd.DataFrame(np.nan, index=days, columns=["value", "climatology", "threshold", "anomaly"])
    frame["value"] = _column(session, series, DailyMean.value, days)
    return frame


def _column(session: Session, series: Series | None, column, days: pd.DatetimeIndex) -> pd.Series:
    """One column of a series' daily means over `days`, missing where there are none."""
    if series is None:
        return pd.Series(np.nan, index=days)
    rows = session.execute(select(DailyMean.date, column).where(DailyMean.series_id == series.id)).all()
    values = pd.Series([row[1] for row in rows], index=pd.DatetimeIndex([row.date for row in rows]))
    return values.reindex(days).astype(float)


def _category(heatwave_days: pd.Series | None, values: pd.Series) -> pd.Series:
    """Each day's heatwave category, 0 on other days with a value, and missing on the rest."""
    outside = pd.Series(np.where(values.notna(), 0.0, np.nan), index=values.index)
    if heatwave_days is None or heatwave_days.empty:
        return outside
    return heatwave_days.reindex(values.index).astype(float).fillna(outside)


def _origin(session: Session, series: Series, category: pd.Series) -> pd.Series:
    """The origin flag of the heatwave each day belongs to: 0 outside heatwaves, missing where unknown."""
    flags = pd.Series(np.where(category.notna(), 0.0, np.nan), index=category.index)
    for start, end, label in session.execute(
        select(Event.start_date, Event.end_date, Event.origin).where(Event.series_id == series.id)
    ):
        flags[str(start) : str(end)] = ORIGIN_FLAGS.index(label) if label else np.nan
    return flags


def daily_dataset(table: pd.DataFrame, buoy: Buoy, depth: int, satellite: Series | None) -> xr.Dataset:
    """One buoy depth's daily series as a CF time series, from `daily_table`."""
    series_id = f"{buoy.id}_{depth:03d}m"
    ds = xr.Dataset(
        {name: ("time", table[name].to_numpy(), attrs) for name, attrs in DAILY_VARIABLES.items()},
        coords={"time": ("time", table.index + pd.Timedelta(hours=12), TIME)},
    )
    ds["series_id"] = ((), series_id, {"cf_role": "timeseries_id", "long_name": "Buoy and depth"})
    ds["station"] = ((), buoy.id, {"long_name": "NERACOOS station", "standard_name": "platform_id"})
    ds["station_name"] = ((), buoy.name, {"long_name": "Station name", "standard_name": "platform_name"})
    ds["latitude"] = ((), buoy.latitude, LATITUDE)
    ds["longitude"] = ((), buoy.longitude, LONGITUDE)
    ds["depth"] = ((), float(depth), DEPTH)
    ds["satellite_latitude"] = (
        (),
        _position(satellite, "latitude"),
        {"long_name": "Latitude of the OISST cell's center", "units": "degrees_north", **REFERENCE},
    )
    ds["satellite_longitude"] = (
        (),
        _position(satellite, "longitude"),
        {"long_name": "Longitude of the OISST cell's center", "units": "degrees_east", **REFERENCE},
    )
    ds["satellite_distance"] = (
        (),
        _position(satellite, "distance_km"),
        {"long_name": "Distance from the buoy to the OISST cell's center", "units": "km", **REFERENCE},
    )
    ds = ds.set_coords(["series_id", "latitude", "longitude", "depth"])

    ds.attrs = {
        "title": f"Marine heatwaves at {buoy.id} ({buoy.name}), {depth} m",
        "summary": (
            f"Daily temperature and salinity at {depth} m on University of Maine buoy {buoy.id} "
            f"({buoy.name}) in the Gulf of Maine, with the {BASELINE[0]}-{BASELINE[1]} normal, the marine "
            "heatwave threshold and anomalies, and the category of each day's heatwave (Hobday et al. 2016, "
            f"2018); each heatwave's origin label, at {' and '.join(map(str, origin.DEPTHS))} m; and NOAA "
            "OISST sea surface temperature at the buoy, treated the same way."
        ),
        "id": f"gom_heatwaves_{series_id}",
        **GLOBAL,
        "source": (
            f"Moored buoy: {NERACOOS_ERDDAP}/tabledap/{buoy.id}_ocean_{depth:03d}m.html. "
            f"Satellite: {COASTWATCH_ERDDAP}/griddap/{OISST}.html and {OISST_PRELIMINARY}."
        ),
        "featureType": "timeSeries",
        "cdm_data_type": "TimeSeries",
        "platform_id": buoy.id,
        "platform_name": f"{buoy.id} - {buoy.name}",
        **_coverage(pd.DatetimeIndex(ds["time"].values)),
        "geospatial_bounds": f"POINT ({buoy.longitude} {buoy.latitude})",
        "geospatial_lat_min": buoy.latitude,
        "geospatial_lat_max": buoy.latitude,
        "geospatial_lon_min": buoy.longitude,
        "geospatial_lon_max": buoy.longitude,
        "geospatial_vertical_min": float(depth),
        "geospatial_vertical_max": float(depth),
    }
    return ds


def _position(series: Series | None, field: str) -> float:
    value = getattr(series, field) if series else None
    return np.nan if value is None else value


def _coverage(times: pd.DatetimeIndex) -> dict:
    """ACDD time coverage, from the first time value to the last, and the file's dates."""
    now = _iso(pd.Timestamp.now(tz="UTC").floor("s"))
    return {
        "time_coverage_start": _iso(times.min()),
        "time_coverage_end": _iso(times.max()),
        "time_coverage_duration": f"P{(times.max() - times.min()).days}D",
        "time_coverage_resolution": "P1D",
        "date_created": now,
        "date_modified": now,
        "date_issued": now,
        "date_metadata_modified": now,
        "history": f"{now} written by heatwaves.products ({REPOSITORY})",
    }


def _iso(time: pd.Timestamp) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ")


def daily_csv(table: pd.DataFrame) -> pd.DataFrame:
    """A daily table as its CSV has it: flags as integers, the origin as a word, blanks for missing."""
    out = table.copy()
    for name in BYTE_VARIABLES & set(out.columns) - {"heatwave_origin"}:
        out[name] = out[name].astype("Int64")
    out["heatwave_origin"] = out["heatwave_origin"].map(
        lambda flag: ORIGIN_FLAGS[int(flag)], na_action="ignore"
    )
    out.index = pd.DatetimeIndex(out.index).date
    out.index.name = "date"
    return out


def events_table(session: Session) -> pd.DataFrame:
    """Every heatwave at the buoys, with the fields of /api/events, oldest first."""
    rows = session.execute(
        select(
            Series.buoy_id,
            Series.depth,
            Event.start_date,
            Event.end_date,
            Event.peak_date,
            Event.max_intensity,
            Event.mean_intensity,
            Event.category,
            Event.origin,
            Buoy.latitude,
            Buoy.longitude,
        )
        .join(Series, Event.series_id == Series.id)
        .join(Buoy, Series.buoy_id == Buoy.id)
        .where(Series.source == "buoy", Series.variable == "temperature")
        .order_by(Event.start_date, Series.buoy_id, Series.depth)
    ).all()
    table = pd.DataFrame(
        rows,
        columns=[
            "buoy_id",
            "depth",
            "start_date",
            "end_date",
            "peak_date",
            "max_intensity",
            "mean_intensity",
            "category",
            "origin",
            "latitude",
            "longitude",
        ],
    )
    table.insert(
        5,
        "duration",
        [(end - start).days + 1 for start, end in zip(table.start_date, table.end_date, strict=True)],
    )
    table.insert(9, "category_name", table["category"].map(CATEGORIES))
    return table


def events_dataset(table: pd.DataFrame) -> xr.Dataset:
    """The events table as CF points, one per heatwave on its first day."""

    def noon(column: str) -> pd.DatetimeIndex:
        return pd.DatetimeIndex(pd.to_datetime(table[column])) + pd.Timedelta(hours=12)

    origin_flags = table["origin"].map(ORIGIN_FLAGS.index, na_action="ignore")
    ds = xr.Dataset(
        {
            "end_time": ("event", noon("end_date"), EVENT_VARIABLES["end_time"]),
            "peak_time": ("event", noon("peak_date"), EVENT_VARIABLES["peak_time"]),
            "duration": ("event", table["duration"].to_numpy(dtype=np.int32), EVENT_VARIABLES["duration"]),
            "max_intensity": (
                "event",
                table["max_intensity"].to_numpy(float),
                EVENT_VARIABLES["max_intensity"],
            ),
            "mean_intensity": (
                "event",
                table["mean_intensity"].to_numpy(float),
                EVENT_VARIABLES["mean_intensity"],
            ),
            "category": ("event", table["category"].to_numpy(dtype=np.int8), EVENT_VARIABLES["category"]),
            "origin": ("event", origin_flags.to_numpy(float), EVENT_VARIABLES["origin"]),
            "station": ("event", table["buoy_id"].to_numpy(str), {"long_name": "NERACOOS station"}),
        },
        coords={
            "time": ("event", noon("start_date"), TIME | {"long_name": "First day of the heatwave"}),
            "latitude": ("event", table["latitude"].to_numpy(float), LATITUDE),
            "longitude": ("event", table["longitude"].to_numpy(float), LONGITUDE),
            "depth": ("event", table["depth"].to_numpy(float), DEPTH),
        },
    )
    positions = table[["longitude", "latitude"]].drop_duplicates().itertuples(index=False)
    ds.attrs = {
        "title": "Marine heatwaves at Gulf of Maine buoys",
        "summary": (
            "Every marine heatwave at 1 to 250 m on the University of Maine's buoys in the Gulf of "
            f"Maine: its dates, intensity and category (Hobday et al. 2016, 2018) against the {BASELINE[0]}-"
            f"{BASELINE[1]} normal, and at {' and '.join(map(str, origin.DEPTHS))} m its origin label."
        ),
        "id": EVENTS,
        **GLOBAL,
        "source": f"Moored buoys: the {{buoy}}_ocean_{{depth}} datasets on {NERACOOS_ERDDAP}",
        "featureType": "point",
        "cdm_data_type": "Point",
        **_coverage(noon("start_date")),
        "geospatial_bounds": f"MULTIPOINT ({', '.join(f'({lon} {lat})' for lon, lat in positions)})",
        "geospatial_lat_min": float(table["latitude"].min()),
        "geospatial_lat_max": float(table["latitude"].max()),
        "geospatial_lon_min": float(table["longitude"].min()),
        "geospatial_lon_max": float(table["longitude"].max()),
        "geospatial_vertical_min": float(table["depth"].min()),
        "geospatial_vertical_max": float(table["depth"].max()),
    }
    return ds


def events_csv(table: pd.DataFrame) -> pd.DataFrame:
    return table.drop(columns=["latitude", "longitude"])


def _write_netcdf(ds: xr.Dataset, path: Path) -> None:
    """NetCDF-3, as ERDDAP serves it: any netCDF library reads it, and one on a URL
    with #mode=bytes reads only the parts it needs over HTTP (NetCDF-4 over HTTP
    needs an HDF5 build that pip's netCDF4 lacks).
    """
    ds.to_netcdf(path, format="NETCDF3_64BIT", encoding=_encoding(ds))


def _encoding(ds: xr.Dataset) -> dict[Hashable, dict]:
    """How each variable is stored: flags and hours as bytes, strings as characters."""
    encoding: dict[Hashable, dict] = {}
    for name, variable in ds.variables.items():
        if name in ("time", "end_time", "peak_time"):
            encoding[name] = TIME_ENCODING | {"_FillValue": None}
        elif name in BYTE_VARIABLES:
            encoding[name] = {"dtype": "int8", "_FillValue": FILL}
        elif variable.dtype.kind in "UO":
            encoding[name] = {"dtype": "S1", "char_dim_name": f"{name}_strlen"}
        elif name in ds.coords or variable.dtype.kind in "iu":
            encoding[name] = {"_FillValue": None}
    return encoding


def write(session: Session, directory: Path) -> None:
    """Write every product to `directory`, replacing each file whole."""
    (directory / DAILY).mkdir(parents=True, exist_ok=True)
    satellites = {
        each.buoy_id: each for each in session.scalars(select(Series).where(Series.source == "satellite"))
    }
    depths = session.execute(
        select(Series.buoy_id, Series.depth)
        .where(Series.source == "buoy", Series.variable == "temperature")
        .order_by(Series.buoy_id, Series.depth)
    ).all()
    for buoy_id, depth in depths:
        buoy = session.get_one(Buoy, buoy_id)
        table = daily_table(session, buoy, depth)
        if table is None:
            continue
        ds = daily_dataset(table, buoy, depth, satellites.get(buoy_id))
        _replace(daily_path(directory, buoy_id, depth, "nc"), partial(_write_netcdf, ds))
        _replace(daily_path(directory, buoy_id, depth, "csv"), daily_csv(table).to_csv)

    events = events_table(session)
    if not events.empty:
        _replace(events_path(directory, "nc"), partial(_write_netcdf, events_dataset(events)))
        _replace(events_path(directory, "csv"), partial(events_csv(events).to_csv, index=False))


def _replace(path: Path, write: Callable[[Path], object]) -> None:
    """Write a file beside `path`, then move it into place: readers see the old file or the new one.

    Each partial file gets a name of its own: a one-off run can write while
    the sync job does, and in their containers both are PID 1.
    """
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".partial")
    os.close(fd)
    partial = Path(name)
    try:
        write(partial)
        # On disk before it takes the name, so a crash can't leave an empty file there.
        with partial.open("rb+") as file:
            os.fsync(file.fileno())
        # mkstemp's file is the owner's alone; the API and ERDDAP read it as other users.
        partial.chmod(_new_file_mode())
        os.replace(partial, path)
    finally:
        partial.unlink(missing_ok=True)  # still there only if the write failed


def _new_file_mode() -> int:
    """The mode open() gives a new file: 0o666 less the umask, which can only be read by setting it."""
    umask = os.umask(0o022)
    os.umask(umask)
    return 0o666 & ~umask


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--out", type=Path, help="directory to write to (default: PRODUCTS_DIR)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    from heatwaves.config import settings
    from heatwaves.db import SessionLocal

    directory = args.out or settings.products_dir
    with SessionLocal() as session:
        write(session, directory)
    log.info("Wrote the products to %s", directory)
    return 0


if __name__ == "__main__":
    sys.exit(main())
