import * as Plot from "@observablehq/plot";
import { extent, range } from "d3";
import { useCallback, useMemo, useRef } from "react";

import { useAnnual } from "../api/queries";
import type { Buoy, Origin, YearSummary } from "../api/types";
import { colors, heatDayBin, heatDayBins } from "../lib/colors";
import { chartDefaults } from "../lib/chart";
import { daysBetween, formatDay, minDay } from "../lib/dates";
import { Chart } from "./Chart";
import { type PlotElement, PlotFigure } from "./PlotFigure";
import { Swatch } from "./StateBadge";

interface Cell extends YearSummary {
  enough: boolean;
}

/** The buoy, year or both whose cells are outlined; null for any. Nothing is outlined when both are null. */
export interface HeatmapSelection {
  buoy: string | null;
  year: number | null;
}

interface Props {
  buoys: Buoy[];
  // Which heatwaves count, as the event filters pick them.
  depth: number | null; // null: any depth
  minCategory: number;
  origin: Origin | null;
  selected: HeatmapSelection;
  onSelect: (buoy: string, year: number) => void;
}

/** Days in `year` so far: a year counts only if at least half of it was observed. */
function daysSoFar(year: number): number {
  return daysBetween(`${year}-01-01`, minDay(`${year + 1}-01-01`, formatDay(new Date())));
}

/**
 * Days inside matching heatwaves per buoy and year, over the years each buoy observed, as /api/annual counts them: at
 * `depth`, or at any of its depths, where a day counts once however many depths were in a heatwave.
 */
export function AnnualHeatmap({ buoys, depth, minCategory, origin, selected, onSelect }: Props) {
  const annual = useAnnual(depth, minCategory, origin);
  // Each buoy's name by its ID, in the buoys' order: the heatmap's rows. Kept while those are: the buoys come anew with
  // every reading the live feed brings, and the same rows in a new map would redraw the heatmap.
  const rows = JSON.stringify(buoys.map((b) => [b.id, b.name]));
  const names = useMemo(() => new Map<string, string>(JSON.parse(rows)), [rows]);
  const cells: Cell[] = useMemo(
    () => (annual.data ?? []).map((d) => ({ ...d, enough: d.observed_days >= daysSoFar(d.year) / 2 })),
    [annual.data],
  );

  return (
    <Chart
      className="chart clickable"
      loading={annual.isPlaceholderData}
      error={annual.isError && "Couldn't load the yearly summary."}
      empty={annual.data?.length === 0 && `No buoy has data${depth === null ? "" : ` at ${depth} m`}.`}
      minHeight={44 + buoys.length * 30}
      legend={
        <div className="legend">
          {heatDayBins.map((bin) => (
            <span className="state" key={bin.label}>
              <Swatch color={bin.color} variant="square" />
              {bin.min === 0 ? "0 days" : bin.label}
            </span>
          ))}
          <span className="state">
            <Swatch color={colors.axis} variant="hollow" />
            Too little data
          </span>
        </div>
      }
      table={{
        columns: [
          { label: "Buoy" },
          { label: "Year", numeric: true },
          { label: "Heatwave days", numeric: true },
          { label: "Days observed", numeric: true },
        ],
        rows: () =>
          cells.map((d) => [`${d.buoy_id} ${names.get(d.buoy_id)}`, d.year, d.enough ? d.heatwave_days : "–", d.observed_days]),
      }}
    >
      {(width) =>
        cells.length > 0 && (
          <Heatmap cells={cells} width={width} names={names} selected={selected} onSelect={onSelect} />
        )
      }
    </Chart>
  );
}

function isSelected(cell: Cell, { buoy, year }: HeatmapSelection): boolean {
  if (buoy === null && year === null) return false;
  return (buoy === null || cell.buoy_id === buoy) && (year === null || cell.year === year);
}

interface HeatmapProps extends Pick<Props, "selected" | "onSelect"> {
  cells: Cell[];
  width: number;
  names: Map<string, string>; // by buoy ID, a row each, top first
}

function Heatmap({ cells, width, names, selected, onSelect }: HeatmapProps) {
  const { buoy: selectedBuoy, year: selectedYear } = selected;
  const [first, last] = extent(cells, (d) => d.year) as [number, number];
  const options = useMemo((): Plot.PlotOptions => {
    const chartWidth = Math.max(width, 640);
    const describe = (d: Cell) =>
      `${d.buoy_id} ${names.get(d.buoy_id)}, ${d.year}\n` +
      (d.enough
        ? `${d.heatwave_days} heatwave days\n${d.observed_days} days observed`
        : `Too little data (${d.observed_days} days observed)`) +
      "\nClick to list its heatwaves";
    return {
      ...chartDefaults,
      width: chartWidth,
      height: 44 + names.size * 30,
      marginLeft: 44,
      marginRight: 20,
      x: { domain: range(first, last + 1), label: null, tickFormat: (y: number) => (y % 5 === 0 || chartWidth > 900 ? String(y) : "") },
      y: { domain: [...names.keys()], label: null },
      marks: [
        Plot.cell(
          cells.filter((d) => d.enough),
          { x: "year", y: "buoy_id", fill: (d: Cell) => heatDayBin(d.heatwave_days).color, inset: 1, rx: 3 },
        ),
        Plot.cell(
          cells.filter((d) => !d.enough),
          { x: "year", y: "buoy_id", fill: colors.surface, stroke: colors.axis, inset: 1.5, rx: 3 },
        ),
        // The buoy and year the list below is filtered to.
        Plot.cell(
          cells.filter((d) => isSelected(d, { buoy: selectedBuoy, year: selectedYear })),
          { x: "year", y: "buoy_id", fill: "none", stroke: colors.ink, strokeWidth: 2, rx: 4 },
        ),
        Plot.tip(cells, Plot.pointer({ x: "year", y: "buoy_id", title: describe })),
      ],
    };
  }, [cells, width, first, last, names, selectedBuoy, selectedYear]);

  // On narrow screens the grid scrolls sideways. It starts at the recent years, and keeps its place when it's redrawn
  // for a selected cell or new data; only other years, or another width, start it at the recent years again.
  const scroll = useRef({ layout: "", left: 0 });
  const layout = `${first}-${last} ${width}`;
  // Plot's pointer interaction keeps the cell under the cursor in `plot.value`.
  const onRender = useCallback(
    (plot: PlotElement) => {
      const frame = plot.closest(".chart");
      if (frame) {
        frame.scrollLeft = scroll.current.layout === layout ? scroll.current.left : frame.scrollWidth;
        scroll.current.layout = layout;
      }
      const click = () => {
        if (plot.value) onSelect(plot.value.buoy_id, plot.value.year);
      };
      plot.addEventListener("click", click);
      return () => {
        // Read before the plot goes, while the grid still holds the place.
        if (frame) scroll.current.left = frame.scrollLeft;
        plot.removeEventListener("click", click);
      };
    },
    [onSelect, layout],
  );

  return <PlotFigure options={options} onRender={onRender} />;
}
