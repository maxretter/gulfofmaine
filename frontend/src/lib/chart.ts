import type * as Plot from "@observablehq/plot";

import { colors } from "./colors";

/** What every chart shares: small secondary-ink text, colours given directly, room for the y axis. */
export const chartDefaults = {
  style: { fontSize: "12px", color: colors.ink2, overflow: "visible" },
  color: { type: "identity" },
  marginLeft: 40,
  marginRight: 12,
} satisfies Plot.PlotOptions;
