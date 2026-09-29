"""The series this app tracks, and the climatology baseline.

A series is one variable at one depth on one buoy, from one source. The
buoys are the UMaine-operated NERACOOS buoys with 17+ years of temperature
and salinity at fixed depths; names follow each dataset's ERDDAP summary.
Each buoy also has a satellite series: sea surface temperature from NOAA's
OISST in the nearest grid cell with data, the record GMRI's Gulf of Maine
temperature reports use.

Two buoys are retired but kept for their history, which heatwaves.origin
uses to tell where the heat at depth came from: M01, deep in Jordan Basin,
stopped reporting in September 2025, and N01, in the Northeast Channel
where slope water enters the Gulf, in October 2021.
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

# Each buoy's fixed depths, in metres. M01's sensors below 50 m sit in the
# deep water of Jordan Basin, below the reach of winter mixing.
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

# Climatology baseline. Hobday et al. recommend 30 years, but the buoys'
# records begin in 2001-2003, so this is the longest period every one of them
# covers. It is fixed rather than moving, so heatwaves become more frequent as
# the Gulf warms; that is the definition working as intended.
BASELINE = (2003, 2022)


@dataclass(frozen=True)
class SeriesSpec:
    buoy: str
    depth: int  # metres
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
