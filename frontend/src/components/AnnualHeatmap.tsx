import * as Plot from "@observablehq/plot";
import { extent, range } from "d3";
import { useCallback, useMemo } from "react";

import { useAnnual } from "../api/queries";
import type { Buoy, YearSummary } from "../api/types";
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
  depth: number;
  buoys: Buoy[];
  selected: HeatmapSelection;
  onSelect: (buoy: string, year: number) => void;
}

/** Days in `year` so far: a year counts only if at least half of it was observed. */
function daysSoFar(year: number): number {
  return daysBetween(`${year}-01-01`, minDay(`${year + 1}-01-01`, formatDay(new Date())));
}

export function AnnualHeatmap({ depth, buoys, selected, onSelect }: Props) {
  const annual = useAnnual(depth);
  const names = useMemo(() => new Map(buoys.map((b) => [b.id, b.name])), [buoys]);
  const cells: Cell[] = useMemo(
    () => (annual.data ?? []).map((d) => ({ ...d, enough: d.observed_days >= daysSoFar(d.year) / 2 })),
    [annual.data],
  );

  return (
    <Chart
      className="chart clickable"
      loading={annual.isPlaceholderData}
      error={annual.isError && "Couldn't load the yearly summary."}
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
          <Heatmap
            cells={cells}
            width={width}
            buoys={buoys}
            names={names}
            selected={selected}
            onSelect={onSelect}
          />
        )
      }
    </Chart>
  );
}

function isSelected(cell: Cell, { buoy, year }: HeatmapSelection): boolean {
  if (buoy === null && year === null) return false;
  return (buoy === null || cell.buoy_id === buoy) && (year === null || cell.year === year);
}

interface HeatmapProps extends Omit<Props, "depth"> {
  cells: Cell[];
  width: number;
  names: Map<string, string>;
}

function Heatmap({ cells, width, buoys, names, selected, onSelect }: HeatmapProps) {
  const { buoy: selectedBuoy, year: selectedYear } = selected;
  const options = useMemo((): Plot.PlotOptions => {
    const [first, last] = extent(cells, (d) => d.year) as [number, number];
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
      height: 44 + buoys.length * 30,
      marginLeft: 44,
      marginRight: 20,
      x: { domain: range(first, last + 1), label: null, tickFormat: (y: number) => (y % 5 === 0 || chartWidth > 900 ? String(y) : "") },
      y: { domain: buoys.map((b) => b.id), label: null },
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
  }, [cells, width, buoys, names, selectedBuoy, selectedYear]);

  // Plot's pointer interaction keeps the cell under the cursor in `plot.value`.
  const onRender = useCallback(
    (plot: PlotElement) => {
      // On narrow screens the grid scrolls sideways; start at the recent years.
      const frame = plot.closest(".chart");
      if (frame) frame.scrollLeft = frame.scrollWidth;
      const click = () => {
        if (plot.value) onSelect(plot.value.buoy_id, plot.value.year);
      };
      plot.addEventListener("click", click);
      return () => plot.removeEventListener("click", click);
    },
    [onSelect],
  );

  return <PlotFigure options={options} onRender={onRender} />;
}
