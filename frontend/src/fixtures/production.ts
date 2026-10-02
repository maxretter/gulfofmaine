// The API's answers on the production site, saved on Oct 1, 2026, for tests to check the pages' text against: a
// sentence built from the data should read as it did when it was written out by hand. /api/method and
// /api/origin/rules hold only what the code fixes, so theirs are written by the code itself (heatwaves/api.py).
import type { Agreement, Buoy, EventStatus, HeatwaveEvent, Method, OriginRules } from "../api/types";
import agreement1 from "./production/agreement_1.json";
import agreement20 from "./production/agreement_20.json";
import agreement50 from "./production/agreement_50.json";
import buoysJson from "./production/buoys.json";
import eventsJson from "./production/events.json";
import methodJson from "./production/method.json";
import rulesJson from "./production/origin-rules.json";

/** T as TypeScript types it read from JSON: each union of strings, such as a state, widened to string. */
type Json<T> = T extends string
  ? string
  : T extends (infer Item)[]
    ? Json<Item>[]
    : T extends object
      ? { [Key in keyof T]: Json<T[Key]> }
      : T;

/**
 * A saved answer as the type the app gives it. TypeScript can't tell a string in JSON is one of a union's, so this
 * takes the API's word for those; it type-checks only if the JSON has every field of T, each of the right kind.
 */
function fromJson<T>(json: Json<T>): T {
  return json as T;
}

export const buoys = fromJson<Buoy[]>(buoysJson);
export const method = fromJson<Method>(methodJson);
export const rules = fromJson<OriginRules>(rulesJson);
/** /api/agreement, by depth. */
export const agreements: Record<number, Agreement[]> = { 1: agreement1, 20: agreement20, 50: agreement50 };

// /api/events was saved before it gave each heatwave's status, so that is derived here as heatwaves/api.py's
// event_status has it, from each series' state in the buoys saved with it: a series' most recent heatwave is ongoing
// while the series is in a heatwave, paused while it's paused, and ended otherwise, as is every earlier one.
const captured = fromJson<Omit<HeatwaveEvent, "status">[]>(eventsJson);
const seriesOf = (buoy: string, depth: number) => `${buoy} ${depth}`;
/** Each series' most recent heatwave, the last by start to take its place. */
const latest = new Map(
  captured.toSorted((a, b) => a.start_date.localeCompare(b.start_date)).map((e) => [seriesOf(e.buoy_id, e.depth), e]),
);
const states = new Map(buoys.flatMap((buoy) => buoy.series.map((s) => [seriesOf(buoy.id, s.depth), s.state])));

export const events: HeatwaveEvent[] = captured.map((event) => {
  const series = seriesOf(event.buoy_id, event.depth);
  const state = latest.get(series) === event ? states.get(series) : undefined;
  const status: EventStatus = state === "heatwave" ? "ongoing" : state === "paused" ? "paused" : "ended";
  return { ...event, status };
});
