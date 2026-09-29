import type * as Plot from "@observablehq/plot";

import { colors } from "./colors";

/** What every chart shares: small secondary-ink text in the page's font, colors given directly, room for the y axis. */
export const chartDefaults = {
  style: { fontFamily: "inherit", fontSize: "12px", color: colors.ink2, overflow: "visible" },
  color: { type: "identity" },
  marginLeft: 46, // "1,000" in the page's font
  marginRight: 12,
} satisfies Plot.PlotOptions;
