import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";

import { parseDay } from "../lib/dates";
import type {
  Agreement,
  Buoy,
  DataCatalog,
  Day,
  EventDetail,
  HeatwaveEvent,
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
  originRules: ["origin-rules"],
} as const;

async function getJSON<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json() as Promise<T>;
}

export function useBuoys() {
  return useQuery({ queryKey: keys.buoys, queryFn: () => getJSON<Buoy[]>("/api/buoys") });
}

/** Every heatwave at every buoy and depth: ~700 rows, fetched once and filtered locally. */
export function useEvents() {
  return useQuery({ queryKey: keys.events, queryFn: () => getJSON<HeatwaveEvent[]>("/api/events") });
}

export function useAnnual(depth: number) {
  return useQuery({
    queryKey: [...keys.annual, depth],
    queryFn: () => getJSON<YearSummary[]>(`/api/annual?depth=${depth}`),
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
