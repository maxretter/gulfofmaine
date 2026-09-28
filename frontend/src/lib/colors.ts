// Data colours. Both ramps were checked with a palette validator: monotone
// lightness, one hue family, and the light end at 2:1 or better against the
// chart surface. Page chrome colours live in styles.css.

export const colors = {
  ink: "#0b0b0b",
  ink2: "#52514e",
  muted: "#898781",
  axis: "#c3c2b7",
  grid: "#e1e0d9",
  surface: "#fcfcfb",
  neutral: "#f0efec",
  observed: "#2a78d6",
};

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
