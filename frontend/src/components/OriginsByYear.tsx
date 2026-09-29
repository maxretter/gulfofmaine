import * as Plot from "@observablehq/plot";
import { extent, range } from "d3";
import { useCallback, useMemo } from "react";

import type { HeatwaveEvent, Origin } from "../api/types";
import { chartDefaults } from "../lib/chart";
import { colors, origins } from "../lib/colors";
import { type OriginYear, originsByYear } from "../lib/origin";
import { Chart } from "./Chart";
import { Label } from "./Label";
import { type PlotElement, PlotFigure } from "./PlotFigure";

const ORDER: Origin[] = ["offshore", "surface", "unclear"];
const HEIGHT = 200;
const MAX_BAR = 24; // px

interface Props {
  events: HeatwaveEvent[];
  depth: number;
  year: number; // highlighted
  onSelect: (year: number) => void;
}

/** Heatwaves at one depth per year, stacked by origin, Unclear included. Click a year to map it. */
export function OriginsByYear({ events, depth, year, onSelect }: Props) {
  const rows = useMemo(() => originsByYear(events, depth), [events, depth]);
  const totals = useMemo(() => {
    const counts = Object.fromEntries(ORDER.map((origin) => [origin, 0])) as Record<Origin, number>;
    for (const row of rows) counts[row.origin] += row.count;
    return counts;
  }, [rows]);
  const all = ORDER.reduce((sum, origin) => sum + totals[origin], 0);
  const byYear = useMemo(() => {
    const years = [...new Set(rows.map((r) => r.year))];
    return years.map((y) => [y, ...ORDER.map((o) => rows.find((r) => r.year === y && r.origin === o)?.count ?? 0)]);
  }, [rows]);

  return (
    <Chart
      className="chart clickable"
      minHeight={HEIGHT}
      legend={
        <div className="legend">
          {ORDER.map((origin) => (
            <span key={origin} className="state">
              {/* Square swatches, filled like the bars (a tag draws Unclear hollow). */}
              <Label color={origins[origin].color} variant="square">
                {origins[origin].name}
              </Label>
              <span className="muted">
                {totals[origin]} ({all ? Math.round((100 * totals[origin]) / all) : 0}%)
              </span>
            </span>
          ))}
        </div>
      }
      table={{
        columns: [
          { label: "Year", numeric: true },
          ...ORDER.map((origin) => ({ label: origins[origin].name, numeric: true })),
        ],
        rows: () => byYear,
      }}
    >
      {(width) => rows.length > 0 && <Columns rows={rows} year={year} width={width} onSelect={onSelect} />}
    </Chart>
  );
}

function Columns({ rows, year, width, onSelect }: { rows: OriginYear[]; year: number; width: number; onSelect: (year: number) => void }) {
  const options = useMemo((): Plot.PlotOptions => {
    const [first, last] = extent(rows, (d) => d.year) as [number, number];
    const domain = range(first, last + 1);
    const inner = width - chartDefaults.marginLeft - chartDefaults.marginRight;
    // Bars stay thin, however wide the chart: the band's leftover is air.
    const padding = Math.max(0.2, 1 - MAX_BAR / (inner / domain.length));
    const totals = domain.map((y) => ({ year: y, count: rows.filter((r) => r.year === y).reduce((s, r) => s + r.count, 0) }));
    const tallest = Math.max(...totals.map((t) => t.count));
    const describe = (y: number) => {
      const counts = ORDER.map((o) => `${origins[o].name}: ${rows.find((r) => r.year === y && r.origin === o)?.count ?? 0}`);
      return `${y}\n${counts.join("\n")}\nClick to map this year`;
    };
    return {
      ...chartDefaults,
      width,
      height: HEIGHT,
      marginTop: 8,
      x: { domain, padding, label: null, tickFormat: (y: number) => (y % 5 === 0 ? String(y) : "") },
      y: { label: "heatwaves", grid: true, nice: true },
      marks: [
        // The year mapped below, as a column of shade behind its bar.
        Plot.barY(
          domain.includes(year) ? [{ year, count: tallest }] : [],
          { x: "year", y: "count", fill: colors.neutral, inset: -3 },
        ),
        Plot.barY(
          rows,
          Plot.stackY({
            x: "year",
            y: "count",
            order: ORDER,
            z: "origin",
            fill: (d: OriginYear) => origins[d.origin].color,
            insetTop: 1, // with insetBottom, a 2px gap between the stacked origins
            insetBottom: 1,
          }),
        ),
        Plot.ruleY([0], { stroke: colors.axis }),
        Plot.tip(totals, Plot.pointerX({ x: "year", y: "count", title: (t: { year: number }) => describe(t.year) })),
      ],
    };
  }, [rows, year, width]);

  const onRender = useCallback(
    (plot: PlotElement) => {
      const click = () => {
        if (plot.value) onSelect(plot.value.year);
      };
      plot.addEventListener("click", click);
      return () => plot.removeEventListener("click", click);
    },
    [onSelect],
  );

  return <PlotFigure options={options} onRender={onRender} />;
}
