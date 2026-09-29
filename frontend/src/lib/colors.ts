import { interpolateLab, scaleLinear } from "d3";

// Data colors. Both ramps were checked with a palette validator: monotone
// lightness, one hue family, and the light end at 2:1 or better against the
// chart surface. Page chrome colors live in styles.css.

export const colors = {
  ink: "#0b0b0b",
  ink2: "#52514e",
  muted: "#898781",
  axis: "#c3c2b7",
  grid: "#e1e0d9",
  surface: "#fcfcfb",
  neutral: "#f0efec",
  observed: "#2a78d6",
  // Validated against `observed` (categorical slots 1 and 7) and drawn dashed.
  satellite: "#4a3aa7",
};

/**
 * Heatwave days at depth, by whether the satellite also saw one: the missed
 * days are the story, so they take the heat hue and the rest stay gray.
 */
export const satelliteSaw = {
  missed: "#cf5317",
  seen: colors.muted,
};

/**
 * Where a heatwave's heat likely came from. Categorical slots 6 and 5, checked
 * as a pair with the palette validator (CVD ΔE 17.6); away from the heat hues
 * of the categories, the blue of observations and anomalies, and the
 * satellite's violet. Magenta is under 3:1 on the surface, so an origin is
 * always shown with its name. Unclear is drawn hollow: no call either way.
 */
export const origins = {
  offshore: { name: "Offshore", color: "#008300" },
  surface: { name: "Surface", color: "#e87ba4" },
  unclear: { name: "Unclear", color: colors.muted },
} as const;

/**
 * Temperature anomaly, °C: the reference diverging pair, the blue ramp for
 * colder and the heat ramp below for warmer, about a gray midpoint. Clamped
 * beyond ±3 °C.
 */
export const anomalyScale = {
  domain: [-3, -1.5, 0, 1.5, 3],
  range: ["#1c5cab", "#86b6ef", colors.neutral, "#eba26c", "#a1321a"],
};

const anomalyRamp = scaleLinear<string>()
  .domain(anomalyScale.domain)
  .range(anomalyScale.range)
  .interpolate(interpolateLab)
  .clamp(true);

/** The fill for a temperature anomaly, on the scale above; null for a day without data. */
export function anomalyColor(anomaly: number | null): string | null {
  return anomaly === null ? null : anomalyRamp(anomaly);
}

/** Heatwave categories after Hobday et al. (2018). */
export const categories: Record<number, { name: string; color: string }> = {
  1: { name: "Moderate", color: "#e39200" },
  2: { name: "Strong", color: "#e0590f" },
  3: { name: "Severe", color: "#b3301a" },
  4: { name: "Extreme", color: "#5e1606" },
};

/** Heatwave days in a year, binned: an ordinal ramp in the same hue family. */
export const heatDayBins = [
  { min: 0, label: "0", color: colors.neutral },
  { min: 1, label: "1–14", color: "#eba26c" },
  { min: 15, label: "15–29", color: "#e27b3a" },
  { min: 30, label: "30–59", color: "#cf5317" },
  { min: 60, label: "60–99", color: "#a1321a" },
  { min: 100, label: "100+", color: "#5a1507" },
];

export function heatDayBin(days: number) {
  return heatDayBins.findLast((bin) => days >= bin.min) ?? heatDayBins[0];
}
