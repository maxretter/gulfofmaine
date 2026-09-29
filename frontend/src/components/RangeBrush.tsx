import * as Plot from "@observablehq/plot";
import { type BrushBehavior, brushX, type D3BrushEvent, select, type Selection, utcDay } from "d3";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { type DayPoint, useDaily } from "../api/queries";
import type { HeatwaveEvent } from "../api/types";
import { chartDefaults } from "../lib/chart";
import { categories, colors } from "../lib/colors";
import { addDays, formatDay, parseDay } from "../lib/dates";
import { Chart } from "./Chart";
import { type PlotElement, PlotFigure } from "./PlotFigure";

interface Props {
  buoy: string;
  depth: number;
  firstDate: string;
  lastDate: string;
  from: string;
  to: string;
  events: HeatwaveEvent[]; // this buoy and depth
  onChange: (from: string, to: string) => void;
}

const HEIGHT = 84;
const MARGIN = { top: 4, bottom: 20, left: 40, right: 12 };

interface Brush {
  behavior: BrushBehavior<unknown>;
  group: Selection<SVGGElement, unknown, null, undefined>;
  x: Plot.Scale;
}

/**
 * The whole record at one depth, with heatwaves shaded. Dragging across it
 * picks the period the detailed charts show; the brush also follows range
 * changes made elsewhere (the heatmap, presets, events).
 */
export function RangeBrush({ buoy, depth, ...brush }: Props) {
  const record = useDaily(buoy, depth, brush.firstDate, brush.lastDate);
  // Read here, not only inside the render function: TanStack Query re-renders
  // for the fields a component reads, and that function runs only once the
  // width is known.
  const days = record.data;
  return (
    <Chart
      className="range-brush"
      loading={record.isPlaceholderData}
      error={record.isError && "Couldn't load the full record."}
      minHeight={HEIGHT}
    >
      {(width) => days && <Brush {...brush} record={days} width={width} />}
    </Chart>
  );
}

interface BrushProps extends Omit<Props, "buoy" | "depth"> {
  record: DayPoint[];
  width: number;
}

function Brush({ record, width, firstDate, lastDate, from, to, events, onChange }: BrushProps) {
  // The brush is built once per render of the plot, so it reads the latest
  // range and callback through refs rather than capturing them.
  const brush = useRef<Brush | null>(null);
  const latest = useRef({ from, to, onChange });
  useEffect(() => {
    latest.current = { from, to, onChange };
  });

  const moveTo = useCallback((start: string, end: string) => {
    const current = brush.current;
    if (!current) return;
    current.group.call(current.behavior.move, [current.x.apply(parseDay(start)), current.x.apply(parseDay(end))]);
  }, []);

  const options = useMemo(
    (): Plot.PlotOptions => ({
      ...chartDefaults,
      width,
      height: HEIGHT,
      marginTop: MARGIN.top,
      marginBottom: MARGIN.bottom,
      marginLeft: MARGIN.left,
      marginRight: MARGIN.right,
      x: { type: "utc", domain: [parseDay(firstDate), parseDay(lastDate)], label: null },
      y: { axis: null },
      marks: [
        Plot.rectX(events, {
          x1: (e: HeatwaveEvent) => parseDay(e.start_date),
          x2: (e: HeatwaveEvent) => parseDay(addDays(e.end_date, 1)),
          fill: (e: HeatwaveEvent) => categories[e.category].color,
          fillOpacity: 0.55,
        }),
        Plot.lineY(record, { x: "date", y: "temperature", stroke: colors.observed, strokeWidth: 1 }),
      ],
    }),
    [width, record, events, firstDate, lastDate],
  );

  const onRender = useCallback((plot: PlotElement) => {
    const x = plot.scale("x")!;
    const [left, right] = x.range as [number, number];
    const behavior = brushX()
      .extent([
        [left, MARGIN.top],
        [right, HEIGHT - MARGIN.bottom],
      ])
      .on("end", (event: D3BrushEvent<unknown>) => {
        if (!event.sourceEvent) return; // a programmatic move, not the user
        if (!event.selection) {
          // A click without a drag clears a d3 brush; put the current range back.
          moveTo(latest.current.from, latest.current.to);
          return;
        }
        const [a, b] = (event.selection as [number, number]).map((px) => formatDay(utcDay.round(x.invert!(px))));
        if (a < b) latest.current.onChange(a, b);
      });
    const group = select(plot as SVGSVGElement).append("g").attr("class", "brush").call(behavior);
    brush.current = { behavior, group, x };
    moveTo(latest.current.from, latest.current.to);
    return () => {
      brush.current = null;
    };
  }, [moveTo]);

  useEffect(() => moveTo(from, to), [moveTo, from, to]);

  return <PlotFigure options={options} onRender={onRender} />;
}
