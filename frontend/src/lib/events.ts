import type { DayPoint } from "../api/queries";
import type { HeatwaveEvent } from "../api/types";
import { parseDay } from "./dates";

export interface EventFilters {
  buoy: string | null;
  depth: number | null;
  year: number | null;
  minCategory: number;
}

export type SortKey = "start_date" | "duration" | "max_intensity" | "category";
export interface Sort {
  key: SortKey;
  descending: boolean;
}

/** Events matching every filter; `year` matches events that overlap it. */
export function filterEvents(events: HeatwaveEvent[], filters: EventFilters): HeatwaveEvent[] {
  return events.filter(
    (event) =>
      (filters.buoy === null || event.buoy_id === filters.buoy) &&
      (filters.depth === null || event.depth === filters.depth) &&
      (filters.year === null ||
        (event.start_date <= `${filters.year}-12-31` && event.end_date >= `${filters.year}-01-01`)) &&
      event.category >= filters.minCategory,
  );
}

/** A sorted copy. Ties fall back to newest first, so the order is stable and meaningful. */
export function sortEvents(events: HeatwaveEvent[], sort: Sort): HeatwaveEvent[] {
  const direction = sort.descending ? -1 : 1;
  return [...events].sort((a, b) => {
    const primary = a[sort.key] < b[sort.key] ? -1 : a[sort.key] > b[sort.key] ? 1 : 0;
    return primary * direction || b.start_date.localeCompare(a.start_date);
  });
}

/** Events overlapping [from, to] (ISO days), for one buoy. */
export function eventsInRange(events: HeatwaveEvent[], buoy: string, from: string, to: string) {
  return events.filter((e) => e.buoy_id === buoy && e.start_date <= to && e.end_date >= from);
}


export interface Band {
  date: Date;
  low: number;
  high: number;
  event: number;
  category: number;
}

/**
 * The band to shade on each day of each heatwave: from the threshold up to the
 * temperature. Days in a joined gap can sit below the threshold, so the band
 * is clamped to zero height there.
 */
export function heatwaveBands(days: DayPoint[], events: HeatwaveEvent[]): Band[] {
  return events.flatMap((event, index) => {
    const start = parseDay(event.start_date);
    const end = parseDay(event.end_date);
    return days
      .filter((day) => day.date >= start && day.date <= end)
      .map((day) => ({
        date: day.date,
        low: day.threshold,
        high: day.temperature === null ? day.threshold : Math.max(day.temperature, day.threshold),
        event: index,
        category: event.category,
      }));
  });
}

const SORT_KEYS: SortKey[] = ["start_date", "duration", "max_intensity", "category"];

/** Filters and sort order live in the URL, e.g. /events?buoy=F01&depth=20&sort=duration. */
export function parseEventParams(params: URLSearchParams): { filters: EventFilters; sort: Sort } {
  const number = (name: string) => {
    const value = Number(params.get(name));
    return params.has(name) && Number.isInteger(value) ? value : null;
  };
  const key = params.get("sort") as SortKey;
  return {
    filters: {
      buoy: params.get("buoy")?.toUpperCase() || null,
      depth: number("depth"),
      year: number("year"),
      minCategory: Math.min(Math.max(number("min_category") ?? 1, 1), 4),
    },
    sort: { key: SORT_KEYS.includes(key) ? key : "start_date", descending: params.get("order") !== "asc" },
  };
}

export function toEventParams(filters: EventFilters, sort: Sort): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.buoy) params.set("buoy", filters.buoy);
  if (filters.depth !== null) params.set("depth", String(filters.depth));
  if (filters.year !== null) params.set("year", String(filters.year));
  if (filters.minCategory > 1) params.set("min_category", String(filters.minCategory));
  if (sort.key !== "start_date") params.set("sort", sort.key);
  if (!sort.descending) params.set("order", "asc");
  return params;
}
