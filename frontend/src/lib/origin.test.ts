import { describe, expect, it } from "vitest";

import type { Buoy, Evidence, HeatwaveEvent, OriginRules } from "../api/types";
import { anomalyColor } from "./colors";
import { countVotes, eastToWest, originsByYear, reading, verdict } from "./origin";

const rules: OriginRules = {
  depths: [20, 50],
  before: 30,
  after: 14,
  lookback: 90,
  min_days: 7,
  salty: 0.15,
  fresh: 0,
  drift: -1,
  mixed: 1,
  collapse: 0.5,
  together: 7,
  margin: 2,
  offshore_buoys: ["N01", "M01"],
  western_buoys: ["A01", "B01"],
  deep_buoy: "M01",
  deep_depths: [100, 150, 200, 250],
};

const offshore: Evidence = {
  salinity_anomaly: 0.19,
  surface_heatwave_days: null,
  stratification_before: null,
  stratification_after: null,
  deep_heatwave_days: 10,
  offshore_onset: "2021-01-17",
  western_onset: "2021-03-29",
  votes: { salinity: "offshore", surface_heatwave: null, stratification: null, deep: "offshore", onset_order: "offshore" },
};

describe("verdict", () => {
  it("tallies the votes behind a label", () => {
    expect(countVotes(offshore.votes)).toEqual({ offshore: 3, surface: 0 });
    expect(verdict("offshore", offshore.votes, 2)).toBe("3 of 5 signals point offshore, and none the other way.");
  });

  it("says why a close call is unclear", () => {
    const votes = { ...offshore.votes, deep: "surface" as const, surface_heatwave: "surface" as const };
    expect(verdict("unclear", votes, 2)).toBe(
      "2 signals point offshore and 2 to the surface: a label needs 2 more votes on one side.",
    );
    const none = { salinity: null, surface_heatwave: null, stratification: null, deep: null, onset_order: null };
    expect(verdict("unclear", none, 2)).toBe("None of the signals had the data to vote.");
  });
});

describe("reading", () => {
  it("reads each signal with its rule", () => {
    expect(reading("salinity", offshore, rules, 50)).toMatch(/^\+0\.19 against normal/);
    expect(reading("surface_heatwave", offshore, rules, 50)).toBe("No data at 1 m in the 30 days before onset.");
    expect(reading("deep", offshore, rules, 50)).toMatch(/in a heatwave on 10 days of the 30 before onset/);
    expect(reading("onset_order", offshore, rules, 50)).toBe(
      "Heatwaves began at N01 or M01 on Jan 17, 2021 and at A01 or B01 on Mar 29, 2021: N01 or M01 first, by 71 days.",
    );
  });

  it("says why 1 m's heatwave days did or didn't vote", () => {
    const quiet = { ...offshore, surface_heatwave_days: 0 };
    const voted = { ...quiet, votes: { ...offshore.votes, surface_heatwave: "offshore" as const } };
    expect(reading("surface_heatwave", voted, rules, 50)).toBe(
      "No heatwave at 1 m in the 30 days before onset, which votes offshore.",
    );
    expect(reading("surface_heatwave", { ...quiet, stratification_before: 0.4 }, rules, 50)).toMatch(
      /less than \+1\.0 °C warmer than 50 m, so it doesn't vote\.$/,
    );
    expect(reading("surface_heatwave", { ...quiet, stratification_before: 3 }, rules, 50)).toMatch(/too few days/);
    expect(reading("surface_heatwave", { ...offshore, surface_heatwave_days: 6 }, rules, 50)).toMatch(/votes surface\.$/);
  });

  it("calls onsets within the together window together, and leaves out salinity far below normal", () => {
    const together = { ...offshore, western_onset: "2021-01-20" };
    expect(reading("onset_order", together, rules, 50)).toMatch(/within 7 days of each other: together\.$/);
    const drift = { ...offshore, salinity_anomaly: -2.5 };
    expect(reading("salinity", drift, rules, 50)).toMatch(/leave out anything below −1\.00, so it doesn't vote\.$/);
  });
});

function event(start_date: string, depth: number, origin: HeatwaveEvent["origin"]): HeatwaveEvent {
  return {
    buoy_id: "A01",
    depth,
    start_date,
    end_date: start_date,
    peak_date: start_date,
    duration: 5,
    max_intensity: 2,
    mean_intensity: 1.5,
    category: 1,
    category_name: "Moderate",
    origin,
  };
}

describe("originsByYear", () => {
  it("counts one depth's labeled heatwaves by the year they began", () => {
    const events = [
      event("2021-01-17", 50, "offshore"),
      event("2021-12-30", 50, "offshore"),
      event("2012-01-03", 50, "surface"),
      event("2012-02-02", 20, "surface"),
      event("2012-03-01", 1, null),
    ];
    expect(originsByYear(events, 50)).toEqual([
      { year: 2012, origin: "surface", count: 1 },
      { year: 2021, origin: "offshore", count: 2 },
    ]);
  });
});

describe("eastToWest", () => {
  it("orders the buoys measuring a depth from east to west", () => {
    const buoy = (id: string, longitude: number | null, depths: number[]) =>
      ({ id, longitude, series: depths.map((depth) => ({ depth })) }) as Buoy;
    const buoys = [buoy("A01", -70.6, [1, 50]), buoy("N01", -65.9, [50]), buoy("M01", -67.9, [1, 20, 50]), buoy("X", null, [50])];
    expect(eastToWest(buoys, 50).map((b) => b.id)).toEqual(["N01", "M01", "A01"]);
    expect(eastToWest(buoys, 20).map((b) => b.id)).toEqual(["M01"]);
  });
});

describe("anomalyColor", () => {
  it("is gray at normal, clamps at the ends, and has no color without data", () => {
    expect(anomalyColor(0)).toBe("rgb(240, 239, 236)");
    expect(anomalyColor(9)).toBe(anomalyColor(3));
    expect(anomalyColor(null)).toBeNull();
  });
});
