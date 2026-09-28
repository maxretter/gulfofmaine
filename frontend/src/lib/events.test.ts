import { describe, expect, it } from "vitest";

import type { HeatwaveEvent } from "../api/types";
import { filterEvents, heatwaveBands, parseEventParams, sortEvents, toEventParams } from "./events";

function event(overrides: Partial<HeatwaveEvent>): HeatwaveEvent {
  return {
    buoy_id: "A01",
    depth: 1,
    start_date: "2021-07-01",
    end_date: "2021-07-10",
    peak_date: "2021-07-05",
    duration: 10,
    max_intensity: 2,
    mean_intensity: 1.5,
    category: 1,
    category_name: "Moderate",
    ...overrides,
  };
}

const events = [
  event({ start_date: "2012-05-29", end_date: "2012-10-14", duration: 139, buoy_id: "I01", depth: 50 }),
  event({ start_date: "2020-12-20", end_date: "2021-01-12", duration: 24, category: 2 }),
  event({ start_date: "2021-06-15", end_date: "2021-11-24", duration: 163, buoy_id: "F01", depth: 20 }),
];

describe("filterEvents", () => {
  const none = { buoy: null, depth: null, year: null, minCategory: 1 };

  it("matches a year by overlap, so events crossing New Year count in both", () => {
    expect(filterEvents(events, { ...none, year: 2021 }).map((e) => e.start_date)).toEqual([
      "2020-12-20",
      "2021-06-15",
    ]);
    expect(filterEvents(events, { ...none, year: 2020 })).toHaveLength(1);
  });

  it("combines buoy, depth and category filters", () => {
    expect(filterEvents(events, { ...none, buoy: "F01", depth: 20 })).toHaveLength(1);
    expect(filterEvents(events, { ...none, minCategory: 2 }).map((e) => e.category)).toEqual([2]);
  });
});

describe("sortEvents", () => {
  it("sorts by the chosen column without mutating its input", () => {
    const longestFirst = sortEvents(events, { key: "duration", descending: true });
    expect(longestFirst.map((e) => e.duration)).toEqual([163, 139, 24]);
    expect(events[0].duration).toBe(139);
  });
});

describe("event URL params", () => {
  it("round-trip, clamping the category and ignoring unknown sorts", () => {
    const { filters, sort } = parseEventParams(new URLSearchParams("buoy=f01&depth=20&min_category=9&sort=nope"));
    expect(filters).toEqual({ buoy: "F01", depth: 20, year: null, minCategory: 4 });
    expect(sort).toEqual({ key: "start_date", descending: true });
    expect(toEventParams(filters, sort).toString()).toBe("buoy=F01&depth=20&min_category=4");
  });
});

describe("heatwaveBands", () => {
  it("shades from the threshold up, and not at all on joined days below it", () => {
    const day = (date: string, temperature: number | null) => ({
      date: new Date(`${date}T00:00:00Z`),
      temperature,
      climatology: 10,
      threshold: 11,
    });
    const days = [day("2021-06-30", 12), day("2021-07-01", 12.5), day("2021-07-02", 10.5), day("2021-07-03", null)];

    const bands = heatwaveBands(days, [event({ start_date: "2021-07-01", end_date: "2021-07-03" })]);

    expect(bands.map((b) => [b.low, b.high])).toEqual([
      [11, 12.5],
      [11, 11],
      [11, 11],
    ]);
  });
});
