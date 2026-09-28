"""The buoys, depths and baseline this app tracks.

These are the UMaine-operated NERACOOS buoys with 20+ years of temperature
at fixed depths. Names follow each dataset's ERDDAP summary.
"""

BUOYS = {
    "A01": "Massachusetts Bay",
    "B01": "Western Maine Shelf",
    "E01": "Central Maine Coast",
    "F01": "West Penobscot Bay",
    "I01": "Eastern Maine Shelf",
    "M01": "Jordan Basin",
}

DEPTHS = (1, 20, 50)  # metres

# Climatology baseline. Hobday et al. recommend 30 years, but the buoys'
# records begin in 2001-2003, so this is the longest period every one of them
# covers. It is fixed rather than moving, so heatwaves become more frequent as
# the Gulf warms; that is the definition working as intended.
BASELINE = (2003, 2022)


def dataset_id(buoy: str, depth: int) -> str:
    """ERDDAP dataset ID, e.g. A01_ocean_020m."""
    return f"{buoy}_ocean_{depth:03d}m"
