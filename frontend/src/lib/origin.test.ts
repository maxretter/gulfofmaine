import { describe, expect, it } from "vitest";

import type { Buoy, Evidence, HeatwaveEvent, OriginRules, Reason, Reasons, Signal } from "../api/types";
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

// Why the API says each of `offshore`'s signals voted as it did, or didn't (origin.explain), for a heatwave at E01: on
// neither side of the onset order, it leaves both sides whole.
const explained: Reasons = {
  signals: {
    salinity: "salty",
    surface_heatwave: "too_few_days",
    stratification: "too_few_days",
    deep: "heatwave",
    onset_order: "offshore_first",
  },
  offshore_buoys: ["N01", "M01"],
  western_buoys: ["A01", "B01"],
  left_out: null,
};
/** The sides for a heatwave at A01, B01 alone on the western side, and at M01, N01 alone offshore. */
const atA01 = { offshore_buoys: ["N01", "M01"], western_buoys: ["B01"], left_out: "A01" };
const atM01 = { offshore_buoys: ["N01"], western_buoys: ["A01", "B01"], left_out: "M01" };

/** `explained`, but with these signals' reasons, and for a heatwave at another buoy. */
function because(signals: Partial<Record<Signal, Reason>>, at: Partial<Reasons> = {}): Reasons {
  return { ...explained, ...at, signals: { ...explained.signals, ...signals } };
}

describe("reading", () => {
  it("reads each signal with its rule", () => {
    expect(reading("salinity", offshore, explained, rules, 50)).toMatch(/^\+0\.19 against normal/);
    expect(reading("surface_heatwave", offshore, explained, rules, 50)).toBe(
      "No heatwave at 1 m in the 30 days before onset, but fewer than 7 days of data there, so it doesn't vote.",
    );
    expect(reading("deep", offshore, explained, rules, 50)).toMatch(/in a heatwave on 10 days of the 30 before onset/);
    expect(reading("onset_order", offshore, explained, rules, 50)).toBe(
      "Heatwaves began at N01 or M01 on Jan 17, 2021 and at A01 or B01 on Mar 29, 2021: N01 or M01 first, by 71 days.",
    );
  });

  it("says why 1 m's heatwave days did or didn't vote", () => {
    // 1 m had enough days: none of them in a heatwave.
    const quiet = { ...offshore, surface_heatwave_days: 0 };
    const voted = { ...quiet, stratification_before: 3, votes: { ...offshore.votes, surface_heatwave: "offshore" as const } };
    expect(reading("surface_heatwave", voted, because({ surface_heatwave: "stratified" }), rules, 50)).toBe(
      "No heatwave at 1 m in the 30 days before onset, which votes offshore.",
    );
    expect(reading("surface_heatwave", { ...quiet, stratification_before: 0.4 }, because({ surface_heatwave: "mixed" }), rules, 50)).toMatch(
      /less than \+1\.0 °C warmer than 50 m, so it doesn't vote\.$/,
    );
    // The days short are those with data at 50 m as well, not at 1 m.
    expect(reading("surface_heatwave", quiet, because({ surface_heatwave: "too_few_days_to_compare" }), rules, 50)).toBe(
      "No heatwave at 1 m in the 30 days before onset, but fewer than 7 days had data at both 1 m and 50 m to compare them, so it doesn't vote.",
    );
    expect(
      reading("surface_heatwave", { ...offshore, surface_heatwave_days: 6 }, because({ surface_heatwave: "heatwave" }), rules, 50),
    ).toMatch(/^6 days of heatwave at 1 m .* votes surface\.$/);
  });

  it("says which window of 1 m minus the depth was short of days", () => {
    expect(reading("stratification", offshore, explained, rules, 50)).toBe(
      "Fewer than 7 days had data at both 1 m and 50 m in the 30 days before onset, and fewer than 7 days from onset to 14 days after, so it doesn't vote.",
    );
    expect(
      reading("stratification", { ...offshore, stratification_after: 2 }, because({ stratification: "too_few_days_before" }), rules, 50),
    ).toBe("Fewer than 7 days had data at both 1 m and 50 m in the 30 days before onset, so it doesn't vote.");
    expect(
      reading("stratification", { ...offshore, stratification_before: 3 }, because({ stratification: "too_few_days_after" }), rules, 50),
    ).toBe("Fewer than 7 days had data at both 1 m and 50 m from onset to 14 days after, so it doesn't vote.");
  });

  it("says a lone onset doesn't vote when the other side had too little data to have one", () => {
    const alone = { ...offshore, offshore_onset: null };
    expect(
      reading("onset_order", { ...alone, votes: { ...offshore.votes, onset_order: "surface" } }, because({ onset_order: "western_only" }), rules, 50),
    ).toBe("A heatwave began at A01 or B01 on Mar 29, 2021, and none at N01 or M01 in the 90 days before this one.");
    expect(
      reading("onset_order", { ...alone, votes: { ...offshore.votes, onset_order: null } }, because({ onset_order: "offshore_unobserved" }), rules, 50),
    ).toBe(
      "A heatwave began at A01 or B01 on Mar 29, 2021, but N01 and M01 each had data on fewer than half the 90 days before this one, too few to vote.",
    );
    const east = { ...offshore, western_onset: null, votes: { ...offshore.votes, onset_order: null } };
    expect(reading("onset_order", east, because({ onset_order: "western_unobserved" }), rules, 50)).toMatch(
      /but A01 and B01 each had data on fewer than half/,
    );
  });

  it("leaves the heatwave's own buoy out of its side, and says so", () => {
    expect(reading("onset_order", offshore, because({}, atA01), rules, 50)).toBe(
      "Heatwaves began at N01 or M01 on Jan 17, 2021 and at B01 on Mar 29, 2021: N01 or M01 first, by 71 days. " +
        "Onsets at A01, this heatwave's own buoy, don't count.",
    );
    expect(reading("onset_order", offshore, because({}, atM01), rules, 50)).toMatch(/^Heatwaves began at N01 on .*: N01 first, by 71 days\./);
    expect(reading("onset_order", offshore, explained, rules, 50)).not.toMatch(/own/);
  });

  it("says why the onset order didn't vote, its own buoy left out", () => {
    // At A01, an onset offshore alone: B01, the rest of the western side, had too few days to have had one.
    const east = { ...offshore, western_onset: null, votes: { ...offshore.votes, onset_order: null } };
    expect(reading("onset_order", east, because({ onset_order: "western_unobserved" }, atA01), rules, 50)).toBe(
      "A heatwave began at N01 or M01 on Jan 17, 2021, but B01 had data on fewer than half the 90 days before this one, too few to vote. " +
        "Onsets at A01, this heatwave's own buoy, don't count.",
    );
    // A heatwave seen at no other of the four.
    const none = { ...offshore, offshore_onset: null, western_onset: null, votes: { ...offshore.votes, onset_order: null } };
    expect(reading("onset_order", none, because({ onset_order: "no_onsets" }, atM01), rules, 50)).toBe(
      "No heatwave began at N01, A01 or B01 in the 90 days before this one, so it doesn't vote. " +
        "Onsets at M01, this heatwave's own buoy, don't count.",
    );
    expect(reading("onset_order", none, because({ onset_order: "no_onsets" }), rules, 50)).toBe(
      "No heatwave began at N01, M01, A01 or B01 in the 90 days before this one, so it doesn't vote.",
    );
  });

  it("says too few days, not none, when a signal is short of data", () => {
    const none = { ...offshore, salinity_anomaly: null, deep_heatwave_days: null };
    const short = because({ salinity: "too_few_days", deep: "too_few_days" });
    expect(reading("salinity", none, short, rules, 50)).toBe(
      "Fewer than 7 days of salinity data at 50 m from 30 days before onset to 14 after, so it doesn't vote.",
    );
    expect(reading("deep", none, short, rules, 50)).toBe(
      "M01 at 100–250 m had no heatwave in the 30 days before onset, but no depth there had 7 days of data, so it doesn't vote.",
    );
  });

  it("calls onsets within the together window together, and leaves out salinity far below normal", () => {
    const together = { ...offshore, western_onset: "2021-01-20" };
    expect(reading("onset_order", together, because({ onset_order: "together" }), rules, 50)).toMatch(
      /within 7 days of each other: together\.$/,
    );
    const drift = { ...offshore, salinity_anomaly: -2.5 };
    expect(reading("salinity", drift, because({ salinity: "drift" }), rules, 50)).toMatch(
      /leave out anything below −1\.00, so it doesn't vote\.$/,
    );
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
    status: "ended",
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
