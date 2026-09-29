import { describe, expect, it } from "vitest";

import type { Agreement } from "../api/types";
import { missedByYear, missedShare } from "./agreement";

const row = (buoy_id: string, depth: number, year: number, both: number, buoy_only: number): Agreement => ({
  buoy_id,
  depth,
  year,
  both,
  buoy_only,
  satellite_only: 7,
  neither: 300,
});

describe("what the satellite misses", () => {
  it("counts only heatwave days at depth, over every buoy and year", () => {
    expect(missedShare([row("A01", 50, 2021, 10, 30), row("B01", 50, 2022, 0, 20)])).toBe(50 / 60);
    expect(missedShare([row("A01", 50, 2021, 0, 0)])).toBeNull();
  });

  it("gives one buoy's years in order, shallowest depth first", () => {
    const rows = [row("A01", 50, 2022, 1, 2), row("B01", 20, 2021, 3, 4), row("A01", 20, 2022, 5, 6), row("A01", 20, 2021, 7, 8)];
    expect(missedByYear(rows, "A01")).toEqual([
      { depth: 20, year: 2021, missed: 8, seen: 7 },
      { depth: 20, year: 2022, missed: 6, seen: 5 },
      { depth: 50, year: 2022, missed: 2, seen: 1 },
    ]);
  });

  it("sums every buoy's days by depth and year when no buoy is given", () => {
    const rows = [row("A01", 50, 2021, 1, 2), row("B01", 50, 2021, 3, 4), row("B01", 20, 2021, 5, 6)];
    expect(missedByYear(rows)).toEqual([
      { depth: 20, year: 2021, missed: 6, seen: 5 },
      { depth: 50, year: 2021, missed: 6, seen: 4 },
    ]);
  });
});
