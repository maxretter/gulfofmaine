import { keepPreviousData, type UseQueryResult, useQueries, useQuery } from "@tanstack/react-query";

import { parseDay } from "../lib/dates";
import type {
  Agreement,
  Buoy,
  DataCatalog,
  Day,
  EventDetail,
  HeatwaveEvent,
  MonthAnomaly,
  Onsets,
  OriginRules,
  Variable,
  YearSummary,
} from "./types";

export interface DayPoint extends Omit<Day, "date"> {
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

async function getJSON<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new HttpError(path, response.status);
  return response.json() as Promise<T>;
}

export function useBuoys() {
  return useQuery({ queryKey: keys.buoys, queryFn: () => getJSON<Buoy[]>("/api/buoys") });
}

/** Every heatwave at every buoy and depth: ~700 rows, fetched once and filtered locally. */
export function useEvents() {
  return useQuery({ queryKey: keys.events, queryFn: () => getJSON<HeatwaveEvent[]>("/api/events") });
}

/** Days observed per buoy and year, with a year counting as observed as far as the best-observed of its depths. */
export interface ObservedYear {
  buoy_id: string;
  year: number;
  observed_days: number;
}

function mostObserved(results: UseQueryResult<YearSummary[]>[]) {
  const most = new Map<string, ObservedYear>();
  for (const result of results) {
    for (const { buoy_id, year, observed_days } of result.data ?? []) {
      const key = `${buoy_id}-${year}`;
      if ((most.get(key)?.observed_days ?? -1) < observed_days) most.set(key, { buoy_id, year, observed_days });
    }
  }
  return {
    data: [...most.values()],
    loading: results.some((r) => r.isPending || r.isPlaceholderData),
    error: results.some((r) => r.isError),
  };
}

/** How much of each year each buoy observed at any of `depths`. The combined result keeps its identity until a depth's data changes. */
export function useObservedDays(depths: number[]) {
  return useQueries({
    queries: depths.map((depth) => ({
      queryKey: [...keys.annual, depth],
      queryFn: () => getJSON<YearSummary[]>(`/api/annual?depth=${depth}`),
      placeholderData: keepPreviousData,
    })),
    combine: mostObserved,
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
    // A 404 is a series without a normal: asking again won't change that.
    retry: (failures: number, error: Error) => !isNotFound(error) && failures < 3,
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

/** One heatwave with the evidence for its origin. Heatwaves are addressed by buoy, depth and start date. */
export function useEvent(buoy: string, depth: number, start: string) {
  return useQuery({
    queryKey: [...keys.event, buoy, depth, start],
    queryFn: () => getJSON<EventDetail>(`/api/events/${buoy}/${depth}/${start}`),
  });
}

/** Every buoy's anomalies and heatwave days at one depth through one year. */
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
