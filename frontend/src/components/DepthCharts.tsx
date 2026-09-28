import * as Plot from "@observablehq/plot";
import { max, utcDay } from "d3";
import { useCallback, useMemo, useRef, useState } from "react";

import { type DayPoint, useDailyByDepth } from "../api/queries";
import type { Buoy, HeatwaveEvent } from "../api/types";
import { categories, colors } from "../lib/colors";
import { formatDay, parseDay } from "../lib/dates";
import { heatwaveBands } from "../lib/events";
import { formatDate, formatSigned, formatTemp } from "../lib/format";
import { useElementWidth } from "../lib/useElementWidth";
import { type PlotElement, PlotFigure } from "./PlotFigure";
import { Swatch } from "./StateBadge";
import { TableToggle } from "./TableToggle";

interface Props {
  buoy: Buoy;
  from: string;
  to: string;
  events: HeatwaveEvent[]; // this buoy, every depth
}

interface Panel {
  depth: number;
  days: DayPoint[];
  byDate: Map<string, DayPoint>;
  events: HeatwaveEvent[];
}

/**
 * One chart per depth over the chosen period, sharing a time axis. Hovering
 * any chart moves a crosshair across all three and reads out every depth.
 */
export function DepthCharts({ buoy, from, to, events }: Props) {
  const depths = buoy.series.map((s) => s.depth);
  const results = useDailyByDepth(buoy.id, depths, from, to);
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const [hover, setHover] = useState<Date | null>(null);

  const panels: Panel[] = depths.map((depth, i) => {
    const days = results[i].data ?? [];
    return {
      depth,
      days,
      byDate: new Map(days.map((d) => [formatDay(d.date), d])),
      events: events.filter((e) => e.depth === depth),
    };
  });
  const loading = results.some((r) => r.isPlaceholderData);
  const failed = results.some((r) => r.isError);

  return (
    <div ref={ref} className={`depth-charts${loading ? " loading" : ""}`}>
      {failed && <p className="note">Couldn't load the temperature series.</p>}
      <Readout panels={panels} hover={hover} />
      {width > 0 &&
        panels.map((panel) => (
          <DepthChart key={panel.depth} panel={panel} from={from} to={to} width={width} hover={hover} onHover={setHover} />
        ))}
      <TableToggle
        columns={[
          { label: "Date" },
          { label: "Depth", numeric: true },
          { label: "Daily mean", numeric: true },
          { label: "Normal", numeric: true },
          { label: "Threshold", numeric: true },
        ]}
        rows={() =>
          panels.flatMap((panel) =>
            panel.days.map((d) => [
              formatDay(d.date),
              `${panel.depth} m`,
              formatTemp(d.temperature),
              formatTemp(d.climatology),
              formatTemp(d.threshold),
            ]),
          )
        }
      />
    </div>
  );
}

function activeEvent(events: HeatwaveEvent[], day: string) {
  return events.find((e) => e.start_date <= day && e.end_date >= day);
}

/** Values at the hovered day, or the newest day in the period. */
function Readout({ panels, hover }: { panels: Panel[]; hover: Date | null }) {
  const newest = max(panels.flatMap((p) => p.days.filter((d) => d.temperature !== null).map((d) => d.date)));
  const date = hover ?? newest;
  if (!date) return <div className="readout">No data in this period.</div>;
  const day = formatDay(date);
  return (
    <div className="readout" aria-live="polite">
      <strong>{formatDate(date)}</strong>
      {panels.map((panel) => {
        const point = panel.byDate.get(day);
        const event = activeEvent(panel.events, day);
        return (
          <span key={panel.depth} className="readout-depth">
            <span className="readout-label">{panel.depth} m</span>
            {point?.temperature == null ? (
              "no data"
            ) : (
              <>
                {formatTemp(point.temperature)} <span className="muted">({formatSigned(point.temperature - point.climatology)})</span>
              </>
            )}
            {event && (
              <span className="state">
                <Swatch color={categories[event.category].color} />
                {event.category_name}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

interface ChartProps {
  panel: Panel;
  from: string;
  to: string;
  width: number;
  hover: Date | null;
  onHover: (date: Date | null) => void;
}

function DepthChart({ panel, from, to, width, hover, onHover }: ChartProps) {
  const [x, setX] = useState<Plot.Scale | null>(null);

  const options = useMemo(
    (): Plot.PlotOptions => ({
      width,
      height: 160,
      marginTop: 18,
      marginLeft: 40,
      marginRight: 12,
      style: { fontSize: "12px", color: colors.ink2, overflow: "visible" },
      x: { type: "utc", domain: [parseDay(from), parseDay(to)], label: null },
      y: { label: `${panel.depth} m, °C`, grid: true, nice: true },
      color: { type: "identity" },
      marks: [
        Plot.areaY(heatwaveBands(panel.days, panel.events), {
          x: "date",
          y1: "low",
          y2: "high",
          z: "event",
          fill: (d: { category: number }) => categories[d.category].color,
        }),
        Plot.lineY(panel.days, { x: "date", y: "climatology", stroke: colors.muted, strokeWidth: 1.5 }),
        Plot.lineY(panel.days, { x: "date", y: "threshold", stroke: colors.ink2, strokeWidth: 1.25, strokeDasharray: "4,3" }),
        // Missing days are null, which breaks the line: gaps stay visible.
        Plot.lineY(panel.days, { x: "date", y: "temperature", stroke: colors.observed, strokeWidth: 2 }),
      ],
    }),
    [panel.days, panel.events, panel.depth, from, to, width],
  );

  const onRender = useCallback((plot: PlotElement) => setX(plot.scale("x") ?? null), []);

  const [left, right] = (x?.range ?? [0, 0]) as [number, number];
  const hoverX = hover && x ? x.apply(hover) : null;

  return (
    <div
      className="depth-chart"
      onPointerMove={(event) => {
        if (!x?.invert) return;
        const px = event.clientX - event.currentTarget.getBoundingClientRect().left;
        onHover(px < left || px > right ? null : utcDay.round(x.invert(px)));
      }}
      onPointerLeave={() => onHover(null)}
    >
      <PlotFigure options={options} onRender={onRender} />
      {hoverX !== null && hoverX >= left && hoverX <= right && (
        <div className="crosshair" style={{ left: hoverX }} aria-hidden="true" />
      )}
    </div>
  );
}
