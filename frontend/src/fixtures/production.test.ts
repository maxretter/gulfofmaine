import { describe, expect, it } from "vitest";

import { typeErrors } from "../lib/typeErrors";
import * as production from "./production";

describe("production's saved answers", () => {
  it("give each heatwave the status its series' state had when they were saved", () => {
    const states = production.buoys.flatMap((b) => b.series.map((s) => `${b.id} ${s.depth} m ${s.state}`));
    const status = (e: (typeof production.events)[number]) => `${e.buoy_id} ${e.depth} m from ${e.start_date} ${e.status}`;

    // Three series were in a heatwave and none paused: their latest heatwaves are the ones going on, and every other
    // heatwave, theirs before those among them, has ended.
    expect(states.filter((s) => !/ (normal|offline)$/.test(s))).toEqual([
      "A01 50 m heatwave",
      "B01 1 m heatwave",
      "B01 50 m heatwave",
    ]);
    expect(production.events.filter((e) => e.status !== "ended").map(status)).toEqual([
      "B01 50 m from 2026-09-27 ongoing",
      "A01 50 m from 2026-09-27 ongoing",
      "B01 1 m from 2026-09-21 ongoing",
    ]);
  });

  it("fail the type check if the app's type has a field they lack", { timeout: 60_000 }, () => {
    expect(typeErrors(["fixtures/production.ts"])).toEqual({ "fixtures/production.ts": [] });

    const errors = typeErrors(["fixtures/production.ts"], (types) =>
      types.replace("export interface HeatwaveEvent {", "export interface HeatwaveEvent {\n  speed: number;"),
    );
    expect(errors["fixtures/production.ts"]).toHaveLength(1);
    expect(errors["fixtures/production.ts"][0]).toContain("Property 'speed' is missing");
  });
});
