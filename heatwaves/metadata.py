"""The CF and ACDD attributes of the product files (heatwaves.products).

Each variable's, and the global ones they share; heatwaves.products adds
each file's own, such as its title and bounds.
"""

from typing import get_args

import numpy as np
import pandas as pd

from heatwaves import hobday, origin, qc
from heatwaves.hobday import CATEGORIES
from heatwaves.stations import BASELINE

REPOSITORY = "https://github.com/maxretter/gulfofmaine"

# Flags, as CF flag_values and flag_meanings: each meaning's value is its position.
CATEGORY_FLAGS = ["none", *(name.lower() for name in CATEGORIES.values())]
ORIGIN_FLAGS = ["none", *get_args(origin.Origin)]

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
        "comment": "The most multiples of the threshold's distance above normal the heatwave reached on any "
        "day, which needn't be its peak day (Hobday et al. 2018).",
    },
    "origin": DAILY_VARIABLES["heatwave_origin"] | _flags(ORIGIN_FLAGS, first=1),
}

TIME = {
    "standard_name": "time",
    "long_name": "Time",
    "axis": "T",
    "units_metadata": "leap_seconds: none",
    "comment": (
        "The middle of the UTC day. A buoy's daily value is the mean of the day's hours with data, at least "
        f"{qc.MIN_HOURS} of them (see the *_hours variables), and while the day is under way, of the hours "
        "so far; the satellite's is OISST's daily analysis."
    ),
}
REFERENCE = {"coverage_content_type": "referenceInformation"}
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


def coverage(times: pd.DatetimeIndex) -> dict:
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
