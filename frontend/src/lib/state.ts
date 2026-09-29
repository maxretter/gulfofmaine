import type { Condition } from "../api/types";
import { categories, colors } from "./colors";
import { latest } from "./dates";
import { formatDate, formatList } from "./format";

export type Variant = "dot" | "square" | "ring" | "hollow";

/** How a state is drawn: shared by the badge, the legend and the map markers. */
export function stateLook(condition: Pick<Condition, "state" | "category">): { color: string; variant: Variant } {
  switch (condition.state) {
    case "heatwave":
      return { color: categories[condition.category ?? 1].color, variant: "dot" };
    case "above_threshold":
      return { color: categories[1].color, variant: "ring" };
    case "normal":
      return { color: colors.muted, variant: "dot" };
    default:
      return { color: colors.axis, variant: "hollow" };
  }
}

/**
 * How many of the buoys reporting from `depth` are in a heatwave, and how many more are above the threshold, in a
 * sentence or two. Those with no recent data aren't reporting.
 */
export function heatwaveSummary(conditions: Pick<Condition, "state">[], depth: number): string {
  const reporting = conditions.filter((c) => c.state !== "offline" && c.state !== "no_data").length;
  const hot = conditions.filter((c) => c.state === "heatwave").length;
  const warm = conditions.filter((c) => c.state === "above_threshold").length;
  const buoys = `buoys reporting from ${depth} m`;
  if (reporting === 0) return `No buoy is reporting from ${depth} m.`;
  if (reporting === 1)
    return `The one buoy reporting from ${depth} m ${hot ? "is in a heatwave" : warm ? "is above the heatwave threshold" : "isn't in a heatwave"}.`;
  const heatwaves =
    hot === 0
      ? `None of the ${reporting} ${buoys} is in a heatwave.`
      : hot === reporting
        ? `All ${reporting} ${buoys} are in a heatwave.`
        : `${hot} of the ${reporting} ${buoys} ${hot === 1 ? "is" : "are"} in a heatwave.`;
  if (warm === 0) return heatwaves;
  return `${heatwaves} ${warm}${hot ? " more" : ""} ${warm === 1 ? "is" : "are"} above the threshold.`;
}

/**
 * A buoy's status across its depths, for the list of buoys: the depths in a heatwave, else those above the threshold,
 * else none. `condition` is the one to draw it with: the most severe.
 */
export function buoyStatus(series: Condition[]): { text: string; condition: Condition | null } {
  const reporting = series.filter((s) => s.state !== "offline" && s.state !== "no_data");
  if (reporting.length === 0) {
    const last = latest(series.map((s) => s.date));
    return { text: last ? `No data since ${formatDate(last)}` : "No data yet", condition: series[0] ?? null };
  }
  const hot = reporting.filter((s) => s.state === "heatwave");
  if (hot.length > 0) {
    const worst = hot.reduce((a, b) => ((b.category ?? 0) > (a.category ?? 0) ? b : a));
    return { text: `In a heatwave at ${formatList(hot.map((s) => s.depth))} m`, condition: worst };
  }
  const warm = reporting.filter((s) => s.state === "above_threshold");
  if (warm.length > 0) return { text: `Above the threshold at ${formatList(warm.map((s) => s.depth))} m`, condition: warm[0] };
  return { text: "No heatwave", condition: reporting[0] };
}
