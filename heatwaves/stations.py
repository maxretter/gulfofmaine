"""The series this app tracks, and the climatology baseline.

A series is one variable at one depth on one buoy, from one source. The
buoys are the UMaine-operated NERACOOS buoys with 17+ years of temperature
and salinity at fixed depths; names follow each dataset's ERDDAP summary.
Each buoy also has a satellite series: sea surface temperature from NOAA's
OISST in the nearest grid cell with data.

Two buoys are retired but kept for their history, which heatwaves.origin
uses to tell where the heat at depth came from: M01, deep in Jordan Basin,
stopped reporting in September 2025, and N01, in the Northeast Channel,
in October 2021.
"""

from dataclasses import dataclass

BUOYS = {
    "A01": "Massachusetts Bay",
    "B01": "Western Maine Shelf",
    "E01": "Central Maine Coast",
    "F01": "West Penobscot Bay",
    "I01": "Eastern Maine Shelf",
    "M01": "Jordan Basin",
    "N01": "Northeast Channel",
}

# Each buoy's fixed depths, in meters: M01 also has sensors at 100-250 m.
DEPTHS = {
    "A01": (1, 20, 50),
    "B01": (1, 20, 50),
    "E01": (1, 20, 50),
    "F01": (1, 20, 50),
    "I01": (1, 20, 50),
    "M01": (1, 20, 50, 100, 150, 200, 250),
    "N01": (1, 20, 50),
}

# Measured at every depth. Only temperature is searched for heatwaves.
VARIABLES = ("temperature", "salinity")

# Climatology baseline: 20 years where Hobday et al. recommend 30, as the
# longest records begin in 2001. Not every record covers all of it (N01's
# runs from June 2004 to October 2021), so each series uses the days in it
# that it has data for (heatwaves.hobday.climatology). It is fixed rather than
# moving, so if the water warms, heatwaves against it become more frequent.
BASELINE = (2003, 2022)


@dataclass(frozen=True)
class SeriesSpec:
    buoy: str
    depth: int  # meters
    variable: str  # as named in the dataset, e.g. temperature
    source: str  # what fetches it (heatwaves.sources): "buoy" or "satellite"
    dataset_id: str


# NOAA OISST v2.1 on CoastWatch ERDDAP: the final product, about two weeks
# behind, and the preliminary one, a day behind, which it replaces.
OISST = "ncdcOisst21Agg_LonPM180"
OISST_PRELIMINARY = "ncdcOisst21NrtAgg_LonPM180"


def buoy_series(buoy: str, depth: int, variable: str = "temperature") -> SeriesSpec:
    """A variable from a buoy's fixed-depth ERDDAP dataset, e.g. A01_ocean_020m."""
    return SeriesSpec(buoy, depth, variable, "buoy", f"{buoy}_ocean_{depth:03d}m")


def satellite_series(buoy: str) -> SeriesSpec:
    """Satellite sea surface temperature at a buoy, recorded as depth 0."""
    return SeriesSpec(buoy, 0, "temperature", "satellite", OISST)


SERIES = [
    *(
        buoy_series(buoy, depth, variable)
        for buoy, depths in DEPTHS.items()
        for depth in depths
        for variable in VARIABLES
    ),
    # N01 is here only as evidence for heatwaves.origin, so it has no satellite series.
    *(satellite_series(buoy) for buoy in BUOYS if buoy != "N01"),
]
