import { describe, expect, it } from "vitest";

import { stripes, warmest } from "./stripes";

const row = (month: string, anomaly: number) => ({ month, anomaly, buoys: 3 });

describe("stripes", () => {
  it("runs month by month from the first to the last, across the new year, leaving gaps empty", () => {
    expect(stripes([row("2021-11-01", 1), row("2022-02-01", -0.5), row("2021-12-01", 2)])).toEqual([
      { month: "2021-11", anomaly: 1 },
      { month: "2021-12", anomaly: 2 },
      { month: "2022-01", anomaly: null },
      { month: "2022-02", anomaly: -0.5 },
    ]);
    expect(stripes([])).toEqual([]);
  });

  it("finds the warmest month", () => {
    expect(warmest(stripes([row("2021-11-01", 1), row("2022-02-01", 2.5)]))).toEqual({
      month: "2022-02",
      anomaly: 2.5,
    });
    expect(warmest([{ month: "2021-01", anomaly: null }])).toBeNull();
  });
});
