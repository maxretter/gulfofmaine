"""scripts/readme_figures.py, on the sample record (tests/sample.py)."""

import datetime as dt

import pandas as pd

from heatwaves import hobday
from scripts import readme_figures
from tests import sample


def test_the_figures_count_what_the_readme_says_they_do(session):
    # A01 at 1 and 50 m. Three heatwaves at 50 m: Dec 24, 2020 to Jan 7, 2021, labeled surface;
    # Apr 13 to 28, 2021, offshore, which the satellite's own heatwave, Apr 1 to 20, covers for
    # its first 8 days; and Jun 5 to 14, 2021, unclear.
    sample.build(session)
    events = readme_figures.heatwaves(session)
    # The first began in 2020 but overlaps 2021, so counting 2021's by overlap rather than by
    # start year would change both its count and its days.
    began = [event for event in events if event.start_date.year == 2021]
    overlapping = [event for event in events if event.start_date.year <= 2021 <= event.end_date.year]
    assert (len(began), len(overlapping)) == (2, 3)
    assert sum(map(readme_figures.days, began)) != sum(map(readme_figures.days, overlapping))

    assert readme_figures.figures(session) == [
        "Satellite showed no heatwave on 80% of the 41 heatwave days at 50 m (33).",
        "Satellite showed no heatwave on n/a of the 0 heatwave days at 1 m (0).",
        "Heatwaves at 20 and 50 m that began in 2021: 2; 1 offshore, 0 surface, 1 unclear.",
        "Heatwaves at 20 and 50 m that began in 2012: 0; 0 offshore, 0 surface, 0 unclear.",
        "Unclear: 33% of the 3 labeled heatwaves at 20 and 50 m (1).",
        "Heatwaves that began in 2021 at 1 m lasted 0 days, summed over the buoys.",
        "Heatwaves that began in 2021 at 20 m lasted 0 days, summed over the buoys.",
        "Heatwaves that began in 2021 at 50 m lasted 26 days, summed over the buoys.",
        "Longest heatwave 1 of 3: 16 days at 50 m at A01, 2021-04-13 to 2021-04-28.",
        "Longest heatwave 2 of 3: 15 days at 50 m at A01, 2020-12-24 to 2021-01-07.",
        "Longest heatwave 3 of 3: 10 days at 50 m at A01, 2021-06-05 to 2021-06-14.",
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
