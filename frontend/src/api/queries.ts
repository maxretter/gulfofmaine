import { keepPreviousData, queryOptions, useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";

import { parseDay } from "../lib/dates";
import type { Paths } from "./schema";
import type { Agreement, Day, DayValue, Origin, Responses, Variable } from "./types";

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

/** A path the app fetches, as the API's routes write it: "/api/events/{buoy_id}/{depth}/{start}". */
type Path = keyof Responses & keyof Paths;

type Values = Record<string, string | number | null | undefined>;

/**
 * The URL for `path` with `parameters`: each `{name}` in the path filled in, and the query's values, but for the null
 * and undefined ones, as its query string. The type check holds both to what the path's route takes (schema.ts), so it
 * fails for a path the API doesn't serve, and for a parameter the route doesn't take, or needs but isn't given: one the
 * API renames or drops can't go quietly unheard. Write the parameters in the call: TypeScript checks the names of an
 * object written there, but not those of one made beforehand and passed in.
 */
export function url<P extends Path>(path: P, parameters: Paths[P]["parameters"]): string {
  const { path: names = {}, query = {} } = parameters as { path?: Values; query?: Values };
  const filled = path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(String(names[name])));
  const given = Object.entries(query).filter(([, value]) => value !== null && value !== undefined);
  const search = new URLSearchParams(given.map(([name, value]) => [name, String(value)]));
  return given.length ? `${filled}?${search}` : filled;
}

/**
 * What `path` sends, which contract.ts holds to what its route says it does. `signal` is the one TanStack Query gives
 * each fetch, so a request no longer wanted is abandoned rather than read to the end: one a newer refetch replaces, or
 * one for a page left before it loaded.
 */
async function getJSON<P extends Path>(
  path: P,
  parameters: Paths[P]["parameters"],
  signal: AbortSignal,
): Promise<Responses[P]> {
  const address = url(path, parameters);
  const response = await fetch(address, { headers: { Accept: "application/json" }, signal });
  if (!response.ok) throw new HttpError(address, response.status);
  return response.json() as Promise<Responses[P]>;
}

export function useBuoys() {
  return useQuery({ queryKey: keys.buoys, queryFn: ({ signal }) => getJSON("/api/buoys", {}, signal) });
}

/** Every heatwave at every buoy and depth: ~860 rows, fetched once and filtered locally. */
export function useEvents() {
  return useQuery({ queryKey: keys.events, queryFn: ({ signal }) => getJSON("/api/events", {}, signal) });
}

/**
 * Heatwave days and observed days per buoy and year, at `depth` or, if null, at any depth, where a day counts once
 * however many depths were in a heatwave. Only heatwaves of at least `minCategory`, and of `origin` if given, count.
 */
export function annualQuery(depth: number | null, minCategory: number, origin: Origin | null) {
  return queryOptions({
    queryKey: [...keys.annual, depth, minCategory, origin],
    // Category 1, the API's default, is left out.
    queryFn: ({ signal }) =>
      getJSON(
        "/api/annual",
        { query: { depth, min_category: minCategory > 1 ? minCategory : undefined, origin } },
        signal,
      ),
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
      queryFn: ({ signal }) => getJSON("/api/agreement", { query: { depth } }, signal),
    })),
    combine: combineAgreements,
  });
}

/** Each month's temperature against normal at `depth`, averaged over the buoys: the stripes across the header. */
export function useStripes(depth: number) {
  return useQuery({
    queryKey: [...keys.stripes, depth],
    queryFn: ({ signal }) => getJSON("/api/stripes", { query: { depth } }, signal),
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
      getJSON(
        "/api/buoys/{buoy_id}/{depth}/daily",
        { path: { buoy_id: buoy, depth }, query: { start, end, variable } },
        signal,
      ),
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
      getJSON(
        "/api/buoys/{buoy_id}/{depth}/daily/values",
        { path: { buoy_id: buoy, depth }, query: { start, end } },
        signal,
      ),
    select: withDates<DayValue>,
    placeholderData: keepPreviousData,
    retry,
  });
}

/** One heatwave with the evidence for its origin. Heatwaves are addressed by buoy, depth and start date. */
export function useEvent(buoy: string, depth: number, start: string) {
  return useQuery({
    queryKey: [...keys.event, buoy, depth, start],
    queryFn: ({ signal }) =>
      getJSON("/api/events/{buoy_id}/{depth}/{start}", { path: { buoy_id: buoy, depth, start } }, signal),
  });
}

/** Every buoy's heatwaves, anomalies and heatwave days at one depth through one year. */
export function useOnsets(year: number, depth: number) {
  return useQuery({
    queryKey: [...keys.onsets, year, depth],
    queryFn: ({ signal }) => getJSON("/api/onsets", { query: { year, depth } }, signal),
    placeholderData: keepPreviousData,
  });
}

/** The downloadable products and the variables of the daily files. */
export function useDataCatalog() {
  return useQuery({ queryKey: ["data"], queryFn: ({ signal }) => getJSON("/api/data", {}, signal) });
}

/** The rules that label a heatwave's origin: fixed in the code, so fetched once. */
export const originRulesQuery = queryOptions({
  queryKey: keys.originRules,
  queryFn: ({ signal }) => getJSON("/api/origin/rules", {}, signal),
  staleTime: Infinity,
});

export function useOriginRules() {
  return useQuery(originRulesQuery);
}

/** The method's parameters, and the depths the map shows: fixed in the code, so fetched once. */
export const methodQuery = queryOptions({
  queryKey: keys.method,
  queryFn: ({ signal }) => getJSON("/api/method", {}, signal),
  staleTime: Infinity,
});

export function useMethod() {
  return useQuery(methodQuery);
}
