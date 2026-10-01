import { describe, expect, it } from "vitest";

import type { HeatwaveEvent } from "../api/types";
import {
  eventPath,
  eventRange,
  filterEvents,
  heatwaveBands,
  overlapping,
  parseEventParams,
  rankAmong,
  sortEvents,
  toEventParams,
} from "./events";

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
    origin: null,
    ...overrides,
  };
}

const events = [
  event({ start_date: "2012-05-29", end_date: "2012-10-14", duration: 139, buoy_id: "I01", depth: 50, origin: "surface" }),
  event({ start_date: "2020-12-20", end_date: "2021-01-12", duration: 24, category: 2 }),
  event({ start_date: "2021-06-15", end_date: "2021-11-24", duration: 163, buoy_id: "F01", depth: 20 }),
];

describe("filterEvents", () => {
  const none = { buoy: null, depth: null, year: null, minCategory: 1, origin: null };

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

  it("filters by origin, which only some depths have", () => {
    expect(filterEvents(events, { ...none, origin: "surface" }).map((e) => e.buoy_id)).toEqual(["I01"]);
    expect(filterEvents(events, { ...none, origin: "offshore" })).toEqual([]);
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
    const { filters, sort } = parseEventParams(
      new URLSearchParams("buoy=f01&depth=20&min_category=9&sort=nope&origin=offshore"),
    );
    expect(filters).toEqual({ buoy: "F01", depth: 20, year: null, minCategory: 4, origin: "offshore" });
    expect(sort).toEqual({ key: "start_date", descending: true });
    expect(toEventParams(filters, sort).toString()).toBe("buoy=F01&depth=20&min_category=4&origin=offshore");
    expect(parseEventParams(new URLSearchParams("origin=tropical")).filters.origin).toBeNull();
  });
});

describe("heatwaveBands", () => {
  it("shades from the threshold up, and not at all on joined days below it", () => {
    const day = (date: string, value: number | null) => ({
      date: new Date(`${date}T00:00:00Z`),
      value,
      climatology: 10,
      threshold: 11,
      anomaly: value === null ? null : value - 10,
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

describe("eventRange", () => {
  it("pads an event by half its length, and at least two weeks", () => {
    expect(eventRange(event({ duration: 10 }))).toEqual({ from: "2021-06-17", to: "2021-07-24" });
    expect(eventRange(event({ start_date: "2021-06-15", end_date: "2021-11-24", duration: 163 }))).toEqual({
      from: "2021-03-25",
      to: "2022-02-14",
    });
  });
});

describe("eventPath", () => {
  it("addresses an event by buoy, depth and start date, as the API does", () => {
    expect(eventPath(event({ buoy_id: "A01", depth: 50, start_date: "2021-04-14" }))).toBe("/events/A01/50/2021-04-14");
  });
});

describe("a heatwave among others", () => {
  const events = [
    event({ duration: 40, max_intensity: 3 }),
    event({ start_date: "2020-07-01", duration: 12, max_intensity: 4 }),
    event({ start_date: "2019-07-01", duration: 12, max_intensity: 3 }),
    event({ start_date: "2019-07-01", depth: 20, duration: 90 }),
  ];

  it("ranks it among those at the same buoy and depth, ties sharing a rank", () => {
    expect(rankAmong(events, events[0], "duration")).toEqual({ rank: 1, of: 3 });
    expect(rankAmong(events, events[1], "duration")).toEqual({ rank: 2, of: 3 });
    expect(rankAmong(events, events[2], "duration")).toEqual({ rank: 2, of: 3 });
    expect(rankAmong(events, events[0], "max_intensity")).toEqual({ rank: 2, of: 3 });
  });

  it("finds the others that overlapped it, its own buoy's first", () => {
    const july = event({ start_date: "2021-07-01", end_date: "2021-07-20" });
    const others = [
      july,
      event({ buoy_id: "B01", start_date: "2021-07-15", end_date: "2021-08-01" }),
      event({ buoy_id: "A01", depth: 50, start_date: "2021-06-20", end_date: "2021-07-01" }),
      event({ buoy_id: "A01", depth: 20, start_date: "2021-07-21", end_date: "2021-07-30" }),
      event({ buoy_id: "C01", start_date: "2021-06-01", end_date: "2021-06-30" }),
    ];
    expect(overlapping(others, july).map((e) => `${e.buoy_id} ${e.depth}`)).toEqual(["A01 50", "B01 1"]);
  });
});
