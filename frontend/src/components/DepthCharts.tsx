import * as Plot from "@observablehq/plot";
import { max, utcDay } from "d3";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { type DayPoint, useDaily, useDailyByDepth } from "../api/queries";
import type { Buoy, HeatwaveEvent } from "../api/types";
import { chartDefaults } from "../lib/chart";
import { categories, colors } from "../lib/colors";
import { formatDay, parseDay } from "../lib/dates";
import { heatwaveBands } from "../lib/events";
import { formatDate, formatSigned, formatTemp } from "../lib/format";
import { Chart } from "./Chart";
import { type PlotElement, PlotFigure } from "./PlotFigure";
import { Swatch } from "./StateBadge";

interface Props {
  buoy: Buoy;
  from: string;
  to: string;
  events: HeatwaveEvent[]; // this buoy, every depth
}

const NO_DAYS: DayPoint[] = [];

interface Panel {
  depth: number;
  days: DayPoint[];
  byDate: Map<string, DayPoint>;
  events: HeatwaveEvent[];
  satellite: DayPoint[]; // drawn on the shallowest panel only
}

/**
 * One chart per depth over the chosen period, sharing a time axis, with the
 * satellite's sea surface temperature on the shallowest. Hovering any chart
 * moves a crosshair across all of them and reads out every depth.
 */
export function DepthCharts({ buoy, from, to, events }: Props) {
  const depths = buoy.series.map((s) => s.depth);
  const results = useDailyByDepth(buoy.id, depths, from, to);
  const satellite = useDaily(buoy.id, 0, buoy.satellite ? from : null, to);
  const [hover, setHover] = useState<Date | null>(null);

  const satelliteDays = satellite.data ?? NO_DAYS;
  const panels: Panel[] = depths.map((depth, i) => {
    const days = results[i].data ?? [];
    return {
      depth,
      days,
      byDate: new Map(days.map((d) => [formatDay(d.date), d])),
      events: events.filter((e) => e.depth === depth),
      satellite: i === 0 ? satelliteDays : [],
    };
  });
  const surface = useMemo(() => new Map(satelliteDays.map((d) => [formatDay(d.date), d])), [satelliteDays]);
  const rows = (label: string, days: DayPoint[]) =>
    days.map((d) => [formatDay(d.date), label, formatTemp(d.temperature), formatTemp(d.climatology), formatTemp(d.threshold)]);

  return (
    <Chart
      className="depth-charts"
      loading={results.some((r) => r.isPlaceholderData) || satellite.isPlaceholderData}
      error={(results.some((r) => r.isError) || satellite.isError) && "Couldn't load the temperature series."}
      table={{
        columns: [
          { label: "Date" },
          { label: "Depth" },
          { label: "Daily mean", numeric: true },
          { label: "Normal", numeric: true },
          { label: "Threshold", numeric: true },
        ],
        rows: () => [
          ...(buoy.satellite ? rows("Surface (satellite)", satelliteDays) : []),
          ...panels.flatMap((panel) => rows(`${panel.depth} m`, panel.days)),
        ],
      }}
    >
      {(width) => (
        <>
          <Readout panels={panels} surface={buoy.satellite ? surface : null} hover={hover} />
          {panels.map((panel) => (
            <DepthChart key={panel.depth} panel={panel} from={from} to={to} width={width} hover={hover} onHover={setHover} />
          ))}
        </>
      )}
    </Chart>
  );
}

function activeEvent(events: HeatwaveEvent[], day: string) {
  return events.find((e) => e.start_date <= day && e.end_date >= day);
}

interface ReadoutProps {
  panels: Panel[];
  surface: Map<string, DayPoint> | null; // the satellite's days, if the buoy has a satellite series
  hover: Date | null;
}

/** Values at the hovered day, or the newest day in the period. */
function Readout({ panels, surface, hover }: ReadoutProps) {
  const newest = max(panels.flatMap((p) => p.days.filter((d) => d.temperature !== null).map((d) => d.date)));
  const date = hover ?? newest;
  if (!date) return <div className="readout">No data in this period.</div>;
  const day = formatDay(date);
  return (
    <div className="readout" aria-live="polite">
      <strong>{formatDate(date)}</strong>
      {panels.map((panel) => {
        const event = activeEvent(panel.events, day);
        return (
          <ReadoutValue key={panel.depth} label={`${panel.depth} m`} point={panel.byDate.get(day)}>
            {event && (
              <span className="state">
                <Swatch color={categories[event.category].color} />
                {event.category_name}
              </span>
            )}
          </ReadoutValue>
        );
      })}
      {surface && <ReadoutValue label="Satellite" point={surface.get(day)} />}
    </div>
  );
}

interface ReadoutValueProps {
  label: string;
  point: DayPoint | undefined;
  children?: ReactNode;
}

function ReadoutValue({ label, point, children }: ReadoutValueProps) {
  return (
    <span className="readout-depth">
      <span className="readout-label">{label}</span>
      {point?.temperature == null ? (
        "no data"
      ) : (
        <>
          {formatTemp(point.temperature)} <span className="muted">({formatSigned(point.temperature - point.climatology)})</span>
        </>
      )}
      {children}
    </span>
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
      ...chartDefaults,
      width,
      height: 160,
      marginTop: 18,
      x: { type: "utc", domain: [parseDay(from), parseDay(to)], label: null },
      y: { label: `${panel.depth} m, °C`, grid: true, nice: true },
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
        Plot.lineY(panel.satellite, {
          x: "date",
          y: "temperature",
          stroke: colors.satellite,
          strokeWidth: 2,
          strokeDasharray: "6,4",
        }),
        // Missing days are null, which breaks the line: gaps stay visible.
        Plot.lineY(panel.days, { x: "date", y: "temperature", stroke: colors.observed, strokeWidth: 2 }),
      ],
    }),
    [panel.days, panel.events, panel.depth, panel.satellite, from, to, width],
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
