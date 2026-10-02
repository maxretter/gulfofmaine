import { describe, expect, it } from "vitest";

import type { Condition, State } from "../api/types";
import { categories } from "./colors";
import { buoyStatus, heatwaveSummary, stateLook } from "./state";
import { typeErrors, withValue } from "./typeErrors";

const states = (...list: State[]) => list.map((state) => ({ state }));

describe("how a state is drawn", () => {
  it("draws a paused heatwave dashed, in its category's color: on hold, and unlike above the threshold", () => {
    expect(stateLook({ state: "paused", category: 3 })).toEqual({ color: categories[3].color, variant: "dashed" });
    expect(stateLook({ state: "paused", category: 1 }).variant).not.toBe(stateLook({ state: "above_threshold", category: null }).variant);
    expect(stateLook({ state: "heatwave", category: 3 })).toEqual({ color: categories[3].color, variant: "dot" });
  });
});

describe("the front page's summary", () => {
  it("counts heatwaves among the buoys reporting, leaving out those with no recent data", () => {
    expect(heatwaveSummary(states("heatwave", "normal", "normal", "offline"), 50)).toBe(
      "1 of the 3 buoys reporting from 50 m is in a heatwave.",
    );
    expect(heatwaveSummary(states("heatwave", "heatwave", "normal"), 20)).toBe(
      "2 of the 3 buoys reporting from 20 m are in a heatwave.",
    );
  });

  it("adds the buoys above the threshold, which could be in a heatwave within days", () => {
    expect(heatwaveSummary(states("above_threshold", "above_threshold", "above_threshold", "normal", "normal"), 50)).toBe(
      "None of the 5 buoys reporting from 50 m is in a heatwave. 3 are above the threshold.",
    );
    expect(heatwaveSummary(states("heatwave", "above_threshold", "normal"), 1)).toBe(
      "1 of the 3 buoys reporting from 1 m is in a heatwave. 1 more is above the threshold.",
    );
    expect(heatwaveSummary(states("above_threshold"), 20)).toBe(
      "The one buoy reporting from 20 m is above the heatwave threshold.",
    );
  });

  it("reads naturally at the edges", () => {
    expect(heatwaveSummary(states("normal", "normal"), 1)).toBe("None of the 2 buoys reporting from 1 m is in a heatwave.");
    expect(heatwaveSummary(states("heatwave", "heatwave"), 1)).toBe("All 2 buoys reporting from 1 m are in a heatwave.");
    expect(heatwaveSummary(states("heatwave", "offline"), 50)).toBe("The one buoy reporting from 50 m is in a heatwave.");
    expect(heatwaveSummary(states("no_data"), 50)).toBe("No buoy is reporting from 50 m.");
  });

  it("counts the buoys with a heatwave paused apart from those in one, as it may have ended", () => {
    // Heatwaves and paused ones.
    expect(heatwaveSummary(states("heatwave", "paused", "normal"), 50)).toBe(
      "1 of the 3 buoys reporting from 50 m is in a heatwave, and 1 more has a heatwave paused.",
    );
    expect(heatwaveSummary(states("heatwave", "heatwave", "paused", "paused", "above_threshold", "normal"), 20)).toBe(
      "2 of the 6 buoys reporting from 20 m are in a heatwave, and 2 more have a heatwave paused. 1 more is above the " +
        "threshold.",
    );
    // Paused ones alone.
    expect(heatwaveSummary(states("paused", "normal", "above_threshold"), 20)).toBe(
      "None of the 3 buoys reporting from 20 m is in a heatwave, but 1 has a heatwave paused. 1 more is above the " +
        "threshold.",
    );
    expect(heatwaveSummary(states("paused", "paused", "normal", "normal"), 1)).toBe(
      "None of the 4 buoys reporting from 1 m is in a heatwave, but 2 have a heatwave paused.",
    );
    expect(heatwaveSummary(states("paused", "paused"), 1)).toBe(
      "None of the 2 buoys reporting from 1 m is in a heatwave, but both have a heatwave paused.",
    );
    expect(heatwaveSummary(states("paused", "paused", "paused"), 1)).toBe(
      "None of the 3 buoys reporting from 1 m is in a heatwave, but all 3 have a heatwave paused.",
    );
    expect(heatwaveSummary(states("paused", "offline"), 50)).toBe("The one buoy reporting from 50 m has a heatwave paused.");
    // Heatwaves alone, and neither.
    expect(heatwaveSummary(states("heatwave", "above_threshold"), 50)).toBe(
      "1 of the 2 buoys reporting from 50 m is in a heatwave. 1 more is above the threshold.",
    );
    expect(heatwaveSummary(states("normal", "above_threshold"), 50)).toBe(
      "None of the 2 buoys reporting from 50 m is in a heatwave. 1 is above the threshold.",
    );
  });

  it("leaves the buoys without a normal out of the count, and says so", () => {
    expect(heatwaveSummary(states("heatwave", "normal", "no_normal"), 50)).toBe(
      "1 of the 2 buoys reporting from 50 m is in a heatwave. A buoy without a normal isn't counted.",
    );
    expect(heatwaveSummary(states("normal", "above_threshold", "no_normal", "no_normal"), 20)).toBe(
      "None of the 2 buoys reporting from 20 m is in a heatwave. 1 is above the threshold. 2 buoys without a normal aren't counted.",
    );
    expect(heatwaveSummary(states("no_normal", "offline"), 50)).toBe(
      "No buoy reporting from 50 m has a normal to judge heatwaves by.",
    );
  });
});

const at = (depth: number, state: State, overrides: Partial<Condition> = {}) =>
  ({ depth, state, category: state === "heatwave" ? 1 : null, date: "2026-09-29", ...overrides }) as Condition;

describe("a buoy's status in the list of buoys", () => {
  it("names the depths in a heatwave, drawn in the most severe one's color", () => {
    const status = buoyStatus([at(1, "heatwave"), at(20, "above_threshold"), at(50, "heatwave", { category: 2 })]);
    expect(status.text).toBe("In a heatwave at 1 and 50 m");
    expect(status.condition?.depth).toBe(50);
  });

  it("names the depths where a heatwave is paused, after those where one goes on", () => {
    const both = buoyStatus([at(1, "paused", { category: 4 }), at(20, "heatwave"), at(50, "paused", { category: 2 })]);
    expect([both.text, both.condition?.depth]).toEqual(["In a heatwave at 20 m, paused at 1 and 50 m", 20]);
    const paused = buoyStatus([at(1, "above_threshold"), at(20, "paused", { category: 2 }), at(50, "normal")]);
    expect([paused.text, paused.condition?.depth]).toEqual(["Heatwave paused at 20 m", 20]);
  });

  it("falls back to the depths above the threshold, then to none", () => {
    expect(buoyStatus([at(1, "normal"), at(20, "above_threshold")]).text).toBe("Above the threshold at 20 m");
    expect(buoyStatus([at(1, "normal"), at(20, "offline")]).text).toBe("No heatwave");
  });

  it("says a buoy has no normal only when none of its depths reporting has one", () => {
    const mixed = buoyStatus([at(1, "no_normal"), at(20, "normal")]);
    expect([mixed.text, mixed.condition?.depth]).toEqual(["No heatwave", 20]);
    expect(buoyStatus([at(1, "no_normal"), at(20, "above_threshold")]).text).toBe("Above the threshold at 20 m");
    expect(buoyStatus([at(1, "no_normal"), at(20, "offline")]).text).toBe("No normal");
  });

  it("says when a buoy stopped reporting", () => {
    expect(buoyStatus([at(1, "offline", { date: "2021-10-30" }), at(20, "offline", { date: "2021-10-29" })]).text).toBe(
      "No data since Oct 30, 2021",
    );
    expect(buoyStatus([at(1, "no_data", { date: null })]).text).toBe("No data yet");
  });
});

// contract.ts holds State to the API's, so a state the API adds is added there.
describe("a state added to the API", () => {
  const switches = ["lib/state.ts", "components/StateBadge.tsx"];

  it("fails the type check in each switch over the states until it's given its look and label", { timeout: 60_000 }, () => {
    expect(typeErrors(switches)).toEqual({ "lib/state.ts": [], "components/StateBadge.tsx": [] });
    // Rather than being drawn and labeled as no data, as it was when "paused" was added.
    const error = `Type '"cooling"' is not assignable to type 'never'.`;
    expect(typeErrors(switches, withValue("State", "cooling"))).toEqual({
      "lib/state.ts": [error],
      "components/StateBadge.tsx": [error],
    });
  });
});
