import * as Plot from "@observablehq/plot";
import { extent, range } from "d3";
import { useCallback, useMemo, useRef } from "react";

import { useAnnual } from "../api/queries";
import type { Buoy, YearSummary } from "../api/types";
import { colors, heatDayBin, heatDayBins } from "../lib/colors";
import { useElementWidth } from "../lib/useElementWidth";
import { type PlotElement, PlotFigure } from "./PlotFigure";
import { Swatch } from "./StateBadge";
import { TableToggle } from "./TableToggle";

interface Cell extends YearSummary {
  enough: boolean;
}

interface Props {
  depth: number;
  buoys: Buoy[];
  selectedBuoy: string;
  from: string;
  to: string;
  onSelect: (buoy: string, year: number) => void;
}

/** Days in `year` so far: a year counts only if at least half of it was observed. */
function daysSoFar(year: number): number {
  const end = Math.min(Date.UTC(year + 1, 0, 1), Date.now());
  return Math.round((end - Date.UTC(year, 0, 1)) / 86_400_000);
}

export function AnnualHeatmap({ depth, buoys, selectedBuoy, from, to, onSelect }: Props) {
  const annual = useAnnual(depth);
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const names = useMemo(() => new Map(buoys.map((b) => [b.id, b.name])), [buoys]);

  const cells: Cell[] = useMemo(
    () => (annual.data ?? []).map((d) => ({ ...d, enough: d.observed_days >= daysSoFar(d.year) / 2 })),
    [annual.data],
  );

  const options = useMemo((): Plot.PlotOptions | null => {
    if (!cells.length || !width) return null;
    const [first, last] = extent(cells, (d) => d.year) as [number, number];
    const [fromYear, toYear] = [Number(from.slice(0, 4)), Number(to.slice(0, 4))];
    const chartWidth = Math.max(width, 640);
    const describe = (d: Cell) =>
      `${d.buoy_id} ${names.get(d.buoy_id)}, ${d.year}\n` +
      (d.enough
        ? `${d.heatwave_days} heatwave days\n${d.observed_days} days observed`
        : `Too little data (${d.observed_days} days observed)`) +
      "\nClick to explore";
    return {
      width: chartWidth,
      height: 44 + buoys.length * 30,
      marginLeft: 44,
      style: { fontSize: "12px", color: colors.ink2, overflow: "visible" },
      x: { domain: range(first, last + 1), label: null, tickFormat: (y: number) => (y % 5 === 0 || chartWidth > 900 ? String(y) : "") },
      y: { domain: buoys.map((b) => b.id), label: null },
      color: { type: "identity" },
      marks: [
        Plot.cell(
          cells.filter((d) => d.enough),
          { x: "year", y: "buoy_id", fill: (d: Cell) => heatDayBin(d.heatwave_days).color, inset: 1, rx: 3 },
        ),
        Plot.cell(
          cells.filter((d) => !d.enough),
          { x: "year", y: "buoy_id", fill: colors.surface, stroke: colors.axis, inset: 1.5, rx: 3 },
        ),
        // The buoy and years shown in the detail panel below.
        Plot.cell(
          cells.filter((d) => d.buoy_id === selectedBuoy && d.year >= fromYear && d.year <= toYear),
          { x: "year", y: "buoy_id", fill: "none", stroke: colors.ink, strokeWidth: 2, rx: 4 },
        ),
        Plot.tip(cells, Plot.pointer({ x: "year", y: "buoy_id", title: describe })),
      ],
    };
  }, [cells, width, buoys, names, selectedBuoy, from, to]);

  // Plot's pointer interaction keeps the cell under the cursor in `plot.value`.
  const onRender = useCallback(
    (plot: PlotElement) => {
      // On narrow screens the grid scrolls sideways; start at the recent years.
      if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth;
      const click = () => {
        if (plot.value) onSelect(plot.value.buoy_id, plot.value.year);
      };
      plot.addEventListener("click", click);
      return () => plot.removeEventListener("click", click);
    },
    [onSelect],
  );

  return (
    <>
      {/* Height reserved up front, so the page below doesn't jump when the data arrives. */}
      <div
        ref={ref}
        className={`chart clickable${annual.isPlaceholderData ? " loading" : ""}`}
        style={{ minHeight: 44 + buoys.length * 30 }}
      >
        {annual.isError && <p className="note">Couldn't load the yearly summary.</p>}
        {options && <PlotFigure options={options} onRender={onRender} />}
      </div>
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
      <TableToggle
        columns={[
          { label: "Buoy" },
          { label: "Year", numeric: true },
          { label: "Heatwave days", numeric: true },
          { label: "Days observed", numeric: true },
        ]}
        rows={() =>
          cells.map((d) => [`${d.buoy_id} ${names.get(d.buoy_id)}`, d.year, d.enough ? d.heatwave_days : "–", d.observed_days])
        }
      />
    </>
  );
}
