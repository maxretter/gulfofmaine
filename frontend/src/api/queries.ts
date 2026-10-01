import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";

import { parseDay } from "../lib/dates";
import type {
  Agreement,
  Buoy,
  DataCatalog,
  Day,
  DayValue,
  EventDetail,
  HeatwaveEvent,
  MonthAnomaly,
  Onsets,
  Origin,
  OriginRules,
  Variable,
  YearSummary,
} from "./types";

export interface DayPoint extends Omit<Day, "date"> {
  date: Date;
}

export interface DayValuePoint extends Omit<DayValue, "date"> {
  date: Date;
}

/**
 * The first part of every query key, so the live feed can update and invalidate caches by key. A query's key is
 * one of these followed by its parameters, and a key's leading parts match every query under it.
 */
export const keys = {
  buoys: ["buoys"],
  events: ["events"],
  annual: ["annual"],
  agreement: ["agreement"],
  daily: ["daily"],
  event: ["event"],
  onsets: ["onsets"],
  stripes: ["stripes"],
  originRules: ["origin-rules"],
} as const;

/** A response that wasn't OK, with its status. */
export class HttpError extends Error {
  readonly status: number;

  constructor(path: string, status: number) {
    super(`${path} returned ${status}`);
    this.status = status;
  }
}

/** Whether a query failed with a 404. For a series' days, that means the series has no normal yet. */
export function isNotFound(error: Error | null): boolean {
  return error instanceof HttpError && error.status === 404;
}

/**
 * Every query's retry rule: up to three tries more, as TanStack Query's default, for a network error or a 5xx, but
 * none for a 4xx. A missing heatwave or a series without a normal stays that way however often it's asked for.
 */
export function retry(failures: number, error: Error): boolean {
  return !(error instanceof HttpError && error.status >= 400 && error.status < 500) && failures < 3;
}

async function getJSON<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new HttpError(path, response.status);
  return response.json() as Promise<T>;
}

export function useBuoys() {
  return useQuery({ queryKey: keys.buoys, queryFn: () => getJSON<Buoy[]>("/api/buoys") });
}

/** Every heatwave at every buoy and depth: ~860 rows, fetched once and filtered locally. */
export function useEvents() {
  return useQuery({ queryKey: keys.events, queryFn: () => getJSON<HeatwaveEvent[]>("/api/events") });
}

/**
 * Heatwave days and observed days per buoy and year, at `depth` or, if null, at any depth, where a day counts once
 * however many depths were in a heatwave. Only heatwaves of at least `minCategory`, and of `origin` if given, count.
 */
export function useAnnual(depth: number | null, minCategory: number, origin: Origin | null) {
  const params = new URLSearchParams();
  if (depth !== null) params.set("depth", String(depth));
  if (minCategory > 1) params.set("min_category", String(minCategory));
  if (origin !== null) params.set("origin", origin);
  return useQuery({
    queryKey: [...keys.annual, depth, minCategory, origin],
    queryFn: () => getJSON<YearSummary[]>(`/api/annual?${params}`),
    placeholderData: keepPreviousData,
  });
}

/** Each buoy's heatwave days at `depth` against the satellite's, per year. */
export function useAgreement(depth: number) {
  return useQuery({
    queryKey: [...keys.agreement, depth],
    queryFn: () => getJSON<Agreement[]>(`/api/agreement?depth=${depth}`),
  });
}

/** Each month's temperature against normal at `depth`, averaged over the buoys: the stripes across the header. */
export function useStripes(depth: number) {
  return useQuery({
    queryKey: [...keys.stripes, depth],
    queryFn: () => getJSON<MonthAnomaly[]>(`/api/stripes?depth=${depth}`),
  });
}

/** Depth 0 is the satellite. */
function dailyQuery(buoy: string, depth: number, start: string, end: string, variable: Variable = "temperature") {
  return {
    queryKey: [...keys.daily, buoy, depth, start, end, variable],
    queryFn: async (): Promise<DayPoint[]> => {
      const days = await getJSON<Day[]>(
        `/api/buoys/${buoy}/${depth}/daily?start=${start}&end=${end}&variable=${variable}`,
      );
      return days.map((day) => ({ ...day, date: parseDay(day.date) }));
    },
    // Keep showing the previous range while a new one loads.
    placeholderData: keepPreviousData,
    // A 404 is a series without a normal: asking again won't change that. main.tsx gives every query this rule, but
    // the charts rely on it, so the query carries it too.
    retry,
  };
}

export function useDaily(
  buoy: string,
  depth: number,
  start: string | null,
  end: string | null,
  variable: Variable = "temperature",
) {
  return useQuery({
    ...dailyQuery(buoy, depth, start ?? "", end ?? "", variable),
    enabled: Boolean(start && end),
  });
}

export function useDailyByDepth(buoy: string, depths: number[], start: string, end: string) {
  return useQueries({ queries: depths.map((depth) => dailyQuery(buoy, depth, start, end)) });
}

/** A temperature series' daily means alone, without the normal: a whole record in a third of useDaily's bytes. */
export function useDailyValues(buoy: string, depth: number, start: string, end: string) {
  return useQuery({
    // Under keys.daily, so the live feed refreshes it with the buoy's other days, but never useDaily's key for the
    // same days: the rows aren't the same shape.
    queryKey: [...keys.daily, buoy, depth, start, end, "values"],
    queryFn: async (): Promise<DayValuePoint[]> => {
      const days = await getJSON<DayValue[]>(`/api/buoys/${buoy}/${depth}/daily/values?start=${start}&end=${end}`);
      return days.map((day) => ({ ...day, date: parseDay(day.date) }));
    },
    placeholderData: keepPreviousData,
    retry,
  });
}

/** One heatwave with the evidence for its origin. Heatwaves are addressed by buoy, depth and start date. */
export function useEvent(buoy: string, depth: number, start: string) {
  return useQuery({
    queryKey: [...keys.event, buoy, depth, start],
    queryFn: () => getJSON<EventDetail>(`/api/events/${buoy}/${depth}/${start}`),
  });
}

/** Every buoy's heatwaves, anomalies and heatwave days at one depth through one year. */
export function useOnsets(year: number, depth: number) {
  return useQuery({
    queryKey: [...keys.onsets, year, depth],
    queryFn: () => getJSON<Onsets>(`/api/onsets?year=${year}&depth=${depth}`),
    placeholderData: keepPreviousData,
  });
}

/** The downloadable products and the variables of the daily files. */
export function useDataCatalog() {
  return useQuery({ queryKey: ["data"], queryFn: () => getJSON<DataCatalog>("/api/data") });
}

export function useOriginRules() {
  return useQuery({
    queryKey: keys.originRules,
    queryFn: () => getJSON<OriginRules>("/api/origin/rules"),
    staleTime: Infinity,
  });
}
