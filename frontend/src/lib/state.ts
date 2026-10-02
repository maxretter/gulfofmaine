import type { Condition } from "../api/types";
import { categories, colors } from "./colors";
import { latest } from "./dates";
import { formatDate, formatList } from "./format";

export type Variant = "dot" | "square" | "ring" | "hollow" | "dashed";

/** How a state is drawn: shared by the badge, the legend and the map markers. */
export function stateLook(condition: Pick<Condition, "state" | "category">): { color: string; variant: Variant } {
  switch (condition.state) {
    case "heatwave":
      return { color: categories[condition.category ?? 1].color, variant: "dot" };
    case "paused":
      // The heatwave's color in a dashed outline: on hold, neither going on nor over, and unlike above the threshold.
      return { color: categories[condition.category ?? 1].color, variant: "dashed" };
    case "above_threshold":
      return { color: categories[1].color, variant: "ring" };
    case "normal":
      return { color: colors.muted, variant: "dot" };
    case "no_normal":
      // Reporting, but not judged: hollow like no data, in the darker gray of "no heatwave".
      return { color: colors.muted, variant: "hollow" };
    case "offline":
    case "no_data":
      return { color: colors.axis, variant: "hollow" };
    default: {
      // Every state is listed above, so a new one fails the type check here until it's given a look.
      const unreachable: never = condition.state;
      throw new Error(`No look for the state ${unreachable}`);
    }
  }
}

/**
 * How many of the buoys reporting from `depth` are in a heatwave, how many more have one paused, and how many more are
 * above the threshold, in a sentence or two. A paused heatwave may go on or may turn out to have ended, so a buoy with
 * one is counted apart from those in a heatwave. Those with no recent data aren't reporting. Those without a normal
 * can't be in a heatwave or out of one, so they're left out of the count, and it says so.
 */
export function heatwaveSummary(conditions: Pick<Condition, "state">[], depth: number): string {
  const reporting = conditions.filter((c) => !["offline", "no_data", "no_normal"].includes(c.state)).length;
  const hot = conditions.filter((c) => c.state === "heatwave").length;
  const paused = conditions.filter((c) => c.state === "paused").length;
  const warm = conditions.filter((c) => c.state === "above_threshold").length;
  const unjudged = conditions.filter((c) => c.state === "no_normal").length;
  const buoys = `buoys reporting from ${depth} m`;
  if (reporting === 0) {
    return unjudged
      ? `No buoy reporting from ${depth} m has a normal to judge heatwaves by.`
      : `No buoy is reporting from ${depth} m.`;
  }
  const aside =
    unjudged === 0
      ? ""
      : unjudged === 1
        ? " A buoy without a normal isn't counted."
        : ` ${unjudged} buoys without a normal aren't counted.`;
  if (reporting === 1) {
    const one = hot
      ? "is in a heatwave"
      : paused
        ? "has a heatwave paused"
        : warm
          ? "is above the heatwave threshold"
          : "isn't in a heatwave";
    return `The one buoy reporting from ${depth} m ${one}.${aside}`;
  }
  const has = (count: number) => (count === 1 ? "has" : "have");
  const onHold =
    paused === 0
      ? ""
      : hot > 0
        ? `, and ${paused} more ${has(paused)} a heatwave paused`
        : paused === reporting
          ? `, but ${reporting === 2 ? "both" : `all ${reporting}`} have a heatwave paused`
          : `, but ${paused} ${has(paused)} a heatwave paused`;
  const heatwaves =
    hot === 0
      ? `None of the ${reporting} ${buoys} is in a heatwave${onHold}.`
      : hot === reporting
        ? `All ${reporting} ${buoys} are in a heatwave.`
        : `${hot} of the ${reporting} ${buoys} ${hot === 1 ? "is" : "are"} in a heatwave${onHold}.`;
  if (warm === 0) return `${heatwaves}${aside}`;
  return `${heatwaves} ${warm}${hot + paused ? " more" : ""} ${warm === 1 ? "is" : "are"} above the threshold.${aside}`;
}

/**
 * A buoy's status across its depths, for the list of buoys: the depths in a heatwave and those where one is paused,
 * else those above the threshold, else none, or no normal when none of the depths reporting has one. `condition` is
 * the one to draw it with: the most severe heatwave going on, else the most severe paused.
 */
export function buoyStatus(series: Condition[]): { text: string; condition: Condition | null } {
  const reporting = series.filter((s) => s.state !== "offline" && s.state !== "no_data");
  if (reporting.length === 0) {
    const last = latest(series.map((s) => s.date));
    return { text: last ? `No data since ${formatDate(last)}` : "No data yet", condition: series[0] ?? null };
  }
  const depths = (list: Condition[]) => `${formatList(list.map((s) => s.depth))} m`;
  const worst = (list: Condition[]) => list.reduce((a, b) => ((b.category ?? 0) > (a.category ?? 0) ? b : a));
  const hot = reporting.filter((s) => s.state === "heatwave");
  const paused = reporting.filter((s) => s.state === "paused");
  if (hot.length > 0) {
    const text = `In a heatwave at ${depths(hot)}${paused.length ? `, paused at ${depths(paused)}` : ""}`;
    return { text, condition: worst(hot) };
  }
  if (paused.length > 0) return { text: `Heatwave paused at ${depths(paused)}`, condition: worst(paused) };
  const warm = reporting.filter((s) => s.state === "above_threshold");
  if (warm.length > 0) return { text: `Above the threshold at ${depths(warm)}`, condition: warm[0] };
  const judged = reporting.filter((s) => s.state !== "no_normal");
  if (judged.length === 0) return { text: "No normal", condition: reporting[0] };
  return { text: "No heatwave", condition: judged[0] };
}
