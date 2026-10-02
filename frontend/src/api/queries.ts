import { keepPreviousData, queryOptions, useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";

import { parseDay } from "../lib/dates";
import type {
  Agreement,
  Buoy,
  DataCatalog,
  Day,
  DayValue,
  EventDetail,
  HeatwaveEvent,
  Method,
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
  method: ["method"],
} as const;

/** A response that wasn't OK, with its status. */
export class HttpError extends Error {
  readonly status: number;

  constructor(path: string, status: number) {
    super(`${path} returned ${status}`);
    this.status = status;
  }
}

/**
 * Whether a query failed with a 404. For a series' days, that means the series has no normal yet; for their values
 * alone, which need none, that the API has no such series.
 */
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

/**
 * `signal` is the one TanStack Query gives each fetch, so a request no longer wanted is abandoned rather than read to
 * the end: one a newer refetch replaces, or one for a page left before it loaded.
 */
async function getJSON<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" }, signal });
  if (!response.ok) throw new HttpError(path, response.status);
  return response.json() as Promise<T>;
}

export function useBuoys() {
  return useQuery({ queryKey: keys.buoys, queryFn: ({ signal }) => getJSON<Buoy[]>("/api/buoys", signal) });
}

/** Every heatwave at every buoy and depth: ~860 rows, fetched once and filtered locally. */
export function useEvents() {
  return useQuery({ queryKey: keys.events, queryFn: ({ signal }) => getJSON<HeatwaveEvent[]>("/api/events", signal) });
}

/**
 * Heatwave days and observed days per buoy and year, at `depth` or, if null, at any depth, where a day counts once
 * however many depths were in a heatwave. Only heatwaves of at least `minCategory`, and of `origin` if given, count.
 */
export function annualQuery(depth: number | null, minCategory: number, origin: Origin | null) {
  const params = new URLSearchParams();
  if (depth !== null) params.set("depth", String(depth));
  if (minCategory > 1) params.set("min_category", String(minCategory));
  if (origin !== null) params.set("origin", origin);
  return queryOptions({
    queryKey: [...keys.annual, depth, minCategory, origin],
    queryFn: ({ signal }) => getJSON<YearSummary[]>(`/api/annual?${params}`, signal),
    placeholderData: keepPreviousData,
  });
}

export function useAnnual(depth: number | null, minCategory: number, origin: Origin | null) {
  return useQuery(annualQuery(depth, minCategory, origin));
}

/** Each buoy's heatwave days against the satellite's, per year, at several depths. */
export interface Agreements {
  byDepth: Agreement[][]; // one list per depth, in their order: empty until it loads
  isPending: boolean; // while any depth is
  isError: boolean; // if any depth failed
}

// Outside the hook, so useQueries reruns it only when a result changes, and keeps its result while equal.
function combineAgreements(results: UseQueryResult<Agreement[]>[]): Agreements {
  return {
    byDepth: results.map((result) => result.data ?? []),
    isPending: results.some((result) => result.isPending),
    isError: results.some((result) => result.isError),
  };
}

/** Each buoy's heatwave days at each of `depths` against the satellite's, per year. */
export function useAgreements(depths: number[]): Agreements {
  return useQueries({
    queries: depths.map((depth) => ({
      queryKey: [...keys.agreement, depth],
      queryFn: ({ signal }) => getJSON<Agreement[]>(`/api/agreement?depth=${depth}`, signal),
    })),
    combine: combineAgreements,
  });
}

/** Each month's temperature against normal at `depth`, averaged over the buoys: the stripes across the header. */
export function useStripes(depth: number) {
  return useQuery({
    queryKey: [...keys.stripes, depth],
    queryFn: ({ signal }) => getJSON<MonthAnomaly[]>(`/api/stripes?depth=${depth}`, signal),
  });
}

/**
 * Days with their dates parsed, as the charts take them: the daily queries' `select`. The cache keeps the JSON as it
 * came, so a refetch that brings the same days leaves the cached copy as it was, and TanStack Query runs a `select`
 * defined once, as this is, again only when that copy changes. An unchanged refetch hands back the same days, and no
 * chart redraws; parsed in the query function, they'd be new Dates each time, which never compare equal.
 */
function withDates<T extends { date: string }>(days: T[]): (Omit<T, "date"> & { date: Date })[] {
  return days.map((day) => ({ ...day, date: parseDay(day.date) }));
}

/** Depth 0 is the satellite. */
function dailyQuery(buoy: string, depth: number, start: string, end: string, variable: Variable = "temperature") {
  return {
    queryKey: [...keys.daily, buoy, depth, start, end, variable],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      getJSON<Day[]>(`/api/buoys/${buoy}/${depth}/daily?start=${start}&end=${end}&variable=${variable}`, signal),
    select: withDates<Day>,
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
    // Under keys.daily, so the live feed refreshes it with the other days at its buoy and depth, but never useDaily's
    // key for the same days: the rows aren't the same shape.
    queryKey: [...keys.daily, buoy, depth, start, end, "values"],
    queryFn: ({ signal }) =>
      getJSON<DayValue[]>(`/api/buoys/${buoy}/${depth}/daily/values?start=${start}&end=${end}`, signal),
    select: withDates<DayValue>,
    placeholderData: keepPreviousData,
    retry,
  });
}

/** One heatwave with the evidence for its origin. Heatwaves are addressed by buoy, depth and start date. */
export function useEvent(buoy: string, depth: number, start: string) {
  return useQuery({
    queryKey: [...keys.event, buoy, depth, start],
    queryFn: ({ signal }) => getJSON<EventDetail>(`/api/events/${buoy}/${depth}/${start}`, signal),
  });
}

/** Every buoy's heatwaves, anomalies and heatwave days at one depth through one year. */
export function useOnsets(year: number, depth: number) {
  return useQuery({
    queryKey: [...keys.onsets, year, depth],
    queryFn: ({ signal }) => getJSON<Onsets>(`/api/onsets?year=${year}&depth=${depth}`, signal),
    placeholderData: keepPreviousData,
  });
}

/** The downloadable products and the variables of the daily files. */
export function useDataCatalog() {
  return useQuery({ queryKey: ["data"], queryFn: ({ signal }) => getJSON<DataCatalog>("/api/data", signal) });
}

/** The rules that label a heatwave's origin: fixed in the code, so fetched once. */
export const originRulesQuery = queryOptions({
  queryKey: keys.originRules,
  queryFn: ({ signal }) => getJSON<OriginRules>("/api/origin/rules", signal),
  staleTime: Infinity,
});

export function useOriginRules() {
  return useQuery(originRulesQuery);
}

/** The method's parameters, and the depths the map shows: fixed in the code, so fetched once. */
export const methodQuery = queryOptions({
  queryKey: keys.method,
  queryFn: ({ signal }) => getJSON<Method>("/api/method", signal),
  staleTime: Infinity,
});

export function useMethod() {
  return useQuery(methodQuery);
}
