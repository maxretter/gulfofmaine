"""scripts/readme_figures.py, on the sample record (tests/sample.py)."""

import datetime as dt

import pandas as pd

from heatwaves import hobday
from scripts import readme_figures
from tests import sample


def test_the_figures_count_what_the_readme_says_they_do(session):
    # A01 at 1 and 50 m: one heatwave at 50 m, Apr 13 to 28, 2021, labeled offshore,
    # which the satellite's own heatwave, Apr 1 to 20, covers for its first 8 days.
    sample.build(session)

    assert readme_figures.figures(session) == [
        "Satellite showed no heatwave on 50% of the 16 heatwave days at 50 m (8).",
        "Satellite showed no heatwave on n/a of the 0 heatwave days at 1 m (0).",
        "Heatwaves at 20 and 50 m that began in 2021: 1; 1 offshore, 0 surface, 0 unclear.",
        "Heatwaves at 20 and 50 m that began in 2012: 0; 0 offshore, 0 surface, 0 unclear.",
        "Unclear: 0% of the 1 labeled heatwaves at 20 and 50 m (0).",
        "Heatwaves that began in 2021 at 1 m lasted 0 days, summed over the buoys.",
        "Heatwaves that began in 2021 at 20 m lasted 0 days, summed over the buoys.",
        "Heatwaves that began in 2021 at 50 m lasted 16 days, summed over the buoys.",
        "Long heatwave: 16 days at 50 m at A01, 2021-04-13 to 2021-04-28.",
        # Salinity starts in June 2005, so its windows before then draw on 2006-2021 alone.
        "Fewest baseline years behind any normal, at any time of year: 16, for A01 50 m salinity (buoy).",
    ]


def test_baseline_years_count_each_years_window_as_hobday_pools_it():
    # Dec 28 to Jan 3 in alternate winters, 2003/04 to 2021/22, so every calendar year has days
    # near New Year, but Jan 1's and Dec 31's windows hold values in only ten baseline years.
    winters = [pd.date_range(f"{year}-12-28", f"{year + 1}-01-03") for year in range(2003, 2022, 2)]
    # A window holding a single value is pooled all the same.
    dates = [*(day.date() for winter in winters for day in winter), dt.date(2010, 5, 15)]

    years = readme_figures.baseline_years(dates)

    may_15 = hobday.day_of_year(pd.DatetimeIndex(["2010-05-15"]))[0]
    assert (years[1], years[366], years[may_15], years[may_15 + 6]) == (10, 10, 1, 0)
    assert hobday.FEB_29 not in years.index
