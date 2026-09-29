import pandas as pd

from heatwaves import compare


def test_agreement_counts_each_outcome_over_days_both_observed():
    days = pd.date_range("2021-12-30", "2022-01-04")
    buoy = pd.Series([True, True, False, False, True, True], index=days)
    satellite = pd.Series([True, False, True, False], index=days[:4])  # no data after Jan 2

    table = compare.agreement(buoy, satellite)

    assert table.to_dict("index") == {
        2021: {"both": 1, "satellite_only": 0, "buoy_only": 1, "neither": 0},
        2022: {"both": 0, "satellite_only": 1, "buoy_only": 0, "neither": 1},
    }


def test_in_heatwave_flags_the_observed_days_inside_events():
    observed = pd.date_range("2021-07-01", periods=5)
    heatwave_days = pd.Series(2, index=pd.date_range("2021-07-03", "2021-07-10"))  # category by day

    assert compare.in_heatwave(observed, heatwave_days).tolist() == [False, False, True, True, True]
