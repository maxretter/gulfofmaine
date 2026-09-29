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
import { CategoryLabel } from "./Label";
import { type PlotElement, PlotFigure } from "./PlotFigure";
import { Swatch } from "./StateBadge";

interface Props {
  buoy: Buoy;
  from: string;
  to: string;
  events: HeatwaveEvent[]; // this buoy, every depth
}

const NO_DAYS: DayPoint[] = [];
const PLOT_TOP = 10; // px above each panel's plot area, where the crosshair starts

interface Panel {
  depth: number;
  days: DayPoint[];
  byDate: Map<string, DayPoint>;
  events: HeatwaveEvent[];
  satellite: DayPoint[]; // drawn on the shallowest panel only
}

/** What the lines and shading in DepthCharts mean; the satellite's line only when the buoy has one. */
export function SeriesLegend({ buoy }: { buoy: Buoy }) {
  return (
    <div className="legend series-legend">
      <span className="key">
        <span className="line" style={{ borderColor: colors.observed }} aria-hidden="true" />
        Daily mean
      </span>
      <span className="key">
        <span className="line" style={{ borderColor: colors.muted }} aria-hidden="true" />
        Normal
      </span>
      <span className="key">
        <span className="line dashed" style={{ borderColor: colors.ink2 }} aria-hidden="true" />
        Heatwave threshold (90th percentile)
      </span>
      {buoy.satellite?.first_date && (
        <span className="key">
          <svg width="18" height="4" aria-hidden="true">
            <line x1="0" x2="18" y1="2" y2="2" stroke={colors.satellite} strokeWidth="2" strokeDasharray="6,4" />
          </svg>
          Satellite, at the surface (top chart)
        </span>
      )}
      {Object.entries(categories).map(([n, c]) => (
        <span className="state" key={n}>
          <Swatch color={c.color} variant="square" />
          {c.name}
        </span>
      ))}
    </div>
  );
}

/**
 * One chart per depth over the chosen period, sharing a time axis, with the
 * satellite's sea surface temperature on the shallowest. Hovering any chart
 * moves a crosshair across all of them and reads out every depth.
 */
export function DepthCharts({ buoy, from, to, events }: Props) {
  const depths = buoy.series.map((s) => s.depth);
  const results = useDailyByDepth(buoy.id, depths, from, to);
  // Only once the satellite's record has loaded: before that the API has no normal for it and answers 404.
  const hasSatellite = Boolean(buoy.satellite?.first_date);
  const satellite = useDaily(buoy.id, 0, hasSatellite ? from : null, to);
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
    days.map((d) => [formatDay(d.date), label, formatTemp(d.value), formatTemp(d.climatology), formatTemp(d.threshold)]);

  return (
    <Chart
      className="depth-charts"
      loading={results.some((r) => r.isPlaceholderData) || satellite.isPlaceholderData}
      // The buoy's own series are the chart; without the satellite's it just loses the dashed line.
      error={results.some((r) => r.isError) && "Couldn't load the temperature series."}
      table={{
        columns: [
          { label: "Date" },
          { label: "Depth" },
          { label: "Daily mean", numeric: true },
          { label: "Normal", numeric: true },
          { label: "Threshold", numeric: true },
        ],
        rows: () => [
          ...(hasSatellite ? rows("Surface (satellite)", satelliteDays) : []),
          ...panels.flatMap((panel) => rows(`${panel.depth} m`, panel.days)),
        ],
      }}
    >
      {(width) => (
        <>
          <Readout panels={panels} surface={hasSatellite ? surface : null} hover={hover} />
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
  const newest = max(panels.flatMap((p) => p.days.filter((d) => d.value !== null).map((d) => d.date)));
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
            {event && <CategoryLabel category={event.category} />}
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
      {point?.value == null ? (
        "no data"
      ) : (
        <>
          {formatTemp(point.value)} <span className="muted">({formatSigned(point.anomaly)})</span>
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
      height: 150,
      marginTop: PLOT_TOP,
      x: { type: "utc", domain: [parseDay(from), parseDay(to)], label: null },
      y: { label: null, grid: true, nice: true }, // the panel's heading names it
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
          y: "value",
          stroke: colors.satellite,
          strokeWidth: 2,
          strokeDasharray: "6,4",
        }),
        // Missing days are null, which breaks the line: gaps stay visible.
        Plot.lineY(panel.days, { x: "date", y: "value", stroke: colors.observed, strokeWidth: 2 }),
      ],
    }),
    [panel.days, panel.events, panel.satellite, from, to, width],
  );

  const onRender = useCallback((plot: PlotElement) => setX(plot.scale("x") ?? null), []);

  const [left, right] = (x?.range ?? [0, 0]) as [number, number];
  const hoverX = hover && x ? x.apply(hover) : null;

  return (
    <section className="chart-panel">
      <h3 className="chart-panel-title">
        {panel.depth} m <span className="unit">daily mean, °C</span>
      </h3>
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
          <div className="crosshair" style={{ top: PLOT_TOP, left: hoverX }} aria-hidden="true" />
        )}
      </div>
    </section>
  );
}
