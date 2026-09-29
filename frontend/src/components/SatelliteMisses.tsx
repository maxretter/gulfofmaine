import * as Plot from "@observablehq/plot";
import { extent, range } from "d3";
import { useMemo } from "react";

import { useAgreement } from "../api/queries";
import { type MissedYear, missedByYear } from "../lib/agreement";
import { chartDefaults } from "../lib/chart";
import { colors, satelliteSaw } from "../lib/colors";
import { Chart } from "./Chart";
import { PlotFigure } from "./PlotFigure";
import { Swatch } from "./StateBadge";

const DEPTHS = [20, 50];
const PANEL_HEIGHT = 110;
const MAX_BAR = 24; // px
const GAP = 1; // px each side of the 2px surface gap between stacked segments

/**
 * Heatwave days per year at 20 m and 50 m, split into days the satellite also saw a heatwave at the surface and
 * days it saw none: at one buoy, or without `buoy`, summed over them all.
 */
export function SatelliteMisses({ buoy }: { buoy?: string }) {
  const shallow = useAgreement(DEPTHS[0]);
  const deep = useAgreement(DEPTHS[1]);
  const years = useMemo(
    () => missedByYear([...(shallow.data ?? []), ...(deep.data ?? [])], buoy),
    [shallow.data, deep.data, buoy],
  );
  const results = [shallow, deep];
  const loading = results.some((r) => r.isPending);

  return (
    <Chart
      className="chart"
      loading={loading}
      error={results.some((r) => r.isError) && "Couldn't load the satellite comparison."}
      empty={!loading && years.length === 0 && "No satellite comparison yet: the satellite record hasn't been loaded."}
      minHeight={DEPTHS.length * PANEL_HEIGHT + 40}
      legend={
        <div className="legend">
          <span className="state">
            <Swatch color={satelliteSaw.missed} variant="square" />
            Satellite saw no heatwave
          </span>
          <span className="state">
            <Swatch color={satelliteSaw.seen} variant="square" />
            Satellite saw one too
          </span>
        </div>
      }
      table={{
        columns: [
          { label: "Year", numeric: true },
          { label: "Depth", numeric: true },
          { label: "Heatwave days", numeric: true },
          { label: "Satellite saw none", numeric: true },
          { label: "Share missed", numeric: true },
        ],
        rows: () =>
          years.map((d) => [
            d.year,
            `${d.depth} m`,
            d.missed + d.seen,
            d.missed,
            d.missed + d.seen > 0 ? `${Math.round((100 * d.missed) / (d.missed + d.seen))}%` : "–",
          ]),
      }}
    >
      {(width) => years.length > 0 && <Columns years={years} width={width} />}
    </Chart>
  );
}

function Columns({ years, width }: { years: MissedYear[]; width: number }) {
  const options = useMemo((): Plot.PlotOptions => {
    const [first, last] = extent(years, (d) => d.year) as [number, number];
    const domain = range(first, last + 1);
    const inner = width - chartDefaults.marginLeft - chartDefaults.marginRight;
    // Bars stay thin, however wide the chart: the band's leftover is air.
    const padding = Math.max(0.2, 1 - MAX_BAR / (inner / domain.length));
    const total = (d: MissedYear) => d.missed + d.seen;
    const describe = (d: MissedYear) =>
      `${d.year} at ${d.depth} m: ${total(d)} heatwave days\n` +
      `${d.missed} with no satellite heatwave\n${d.seen} with one at the surface too`;
    const bar = { x: "year", fy: "depth" } as const;
    return {
      ...chartDefaults,
      width,
      height: DEPTHS.length * PANEL_HEIGHT + 30,
      marginTop: 8,
      x: { domain, padding, label: null, tickFormat: (y: number) => (y % 5 === 0 ? String(y) : "") },
      y: { label: null, grid: true, nice: true }, // the caption says what's counted
      fy: { domain: DEPTHS, axis: null },
      marks: [
        Plot.ruleY([0], { stroke: "currentColor", strokeOpacity: 0.3 }),
        // Each panel's depth, at its top left.
        Plot.text(DEPTHS, {
          fy: (d: number) => d,
          text: (d: number) => `${d} m`,
          frameAnchor: "top-left",
          dx: 8,
          dy: 2,
          fill: colors.ink,
          fontWeight: 600,
          stroke: colors.surface, // a halo, so gridlines don't cut through it
          strokeWidth: 4,
        }),
        // Missed days sit on the baseline; days the satellite also saw stack on top.
        Plot.barY(
          years.filter((d) => d.missed > 0 && d.seen > 0),
          { ...bar, y1: 0, y2: "missed", fill: satelliteSaw.missed, insetTop: GAP },
        ),
        Plot.barY(
          years.filter((d) => d.missed > 0 && d.seen === 0),
          { ...bar, y1: 0, y2: "missed", fill: satelliteSaw.missed, ry2: 4 },
        ),
        Plot.barY(
          years.filter((d) => d.seen > 0 && d.missed > 0),
          { ...bar, y1: "missed", y2: total, fill: satelliteSaw.seen, insetBottom: GAP, ry2: 4 },
        ),
        Plot.barY(
          years.filter((d) => d.seen > 0 && d.missed === 0),
          { ...bar, y1: 0, y2: "seen", fill: satelliteSaw.seen, ry2: 4 },
        ),
        Plot.tip(years, Plot.pointerX({ ...bar, y: total, title: describe })),
      ],
    };
  }, [years, width]);

  return <PlotFigure options={options} />;
}
