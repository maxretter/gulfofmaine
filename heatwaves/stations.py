"""The series this app tracks, and the climatology baseline.

A series is one variable at one depth on one buoy, from one source. The
buoys are the UMaine-operated NERACOOS buoys with 20+ years of temperature
at fixed depths; names follow each dataset's ERDDAP summary. Each buoy also
has a satellite series: sea surface temperature from NOAA's OISST in the
nearest grid cell with data, the record GMRI's Gulf of Maine temperature
reports use.
"""

from dataclasses import dataclass

BUOYS = {
    "A01": "Massachusetts Bay",
    "B01": "Western Maine Shelf",
    "E01": "Central Maine Coast",
    "F01": "West Penobscot Bay",
    "I01": "Eastern Maine Shelf",
    "M01": "Jordan Basin",
}

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
    buoy_series("A01", 1),
    buoy_series("A01", 20),
    buoy_series("A01", 50),
    buoy_series("B01", 1),
    buoy_series("B01", 20),
    buoy_series("B01", 50),
    buoy_series("E01", 1),
    buoy_series("E01", 20),
    buoy_series("E01", 50),
    buoy_series("F01", 1),
    buoy_series("F01", 20),
    buoy_series("F01", 50),
    buoy_series("I01", 1),
    buoy_series("I01", 20),
    buoy_series("I01", 50),
    buoy_series("M01", 1),
    buoy_series("M01", 20),
    buoy_series("M01", 50),
    *(satellite_series(buoy) for buoy in BUOYS),
]
