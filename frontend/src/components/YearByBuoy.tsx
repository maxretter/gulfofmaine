import * as Plot from "@observablehq/plot";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router";

import { useOnsets } from "../api/queries";
import type { Buoy, HeatwaveEvent, Onsets, Origin } from "../api/types";
import { chartDefaults } from "../lib/chart";
import { anomalyColor, anomalyScale, colors, origins } from "../lib/colors";
import { maxDay, minDay, parseDay } from "../lib/dates";
import { eventPath } from "../lib/events";
import { formatDate, formatSigned } from "../lib/format";
import { eastToWest } from "../lib/origin";
import { Chart } from "./Chart";
import { Label } from "./Label";
import { type PlotElement, PlotFigure } from "./PlotFigure";

const ORIGINS: Origin[] = ["offshore", "surface", "unclear"];
const DAY = 86_400_000;
// Each buoy's row: the temperature strip on top, its heatwaves in a bar under it, centered on the row's label, and air
// before the next row.
const ROW = 44;
const STRIP = [1, 10]; // px from the top of the row
const BAR = [12, 32];
const AXIS = 30;
const NAMED = 640; // px: from this wide, rows are labeled with the buoy's name too

interface Props {
  year: number;
  depth: number;
  buoys: Buoy[];
}

/**
 * Every buoy's year at one depth, east to west: its heatwaves as bars colored by origin, under a strip of the
 * temperature against normal. A heatwave opens its page.
 */
export function YearByBuoy({ year, depth, buoys }: Props) {
  const onsets = useOnsets(year, depth);
  const order = useMemo(() => eastToWest(buoys, depth), [buoys, depth]);
  const data = onsets.data;
  const rows = useMemo(() => order.map((b) => b.id), [order]);
  const names = useMemo(() => new Map(order.map((b) => [b.id, b.name])), [order]);
  // East to west, and each buoy's oldest first.
  const shown = useMemo(() => {
    const heatwaves = new Map(data?.buoys.map((b) => [b.buoy_id, b.heatwaves]));
    return rows.flatMap((buoy) => heatwaves.get(buoy) ?? []);
  }, [data, rows]);

  return (
    <Chart
      loading={onsets.isPlaceholderData}
      error={onsets.isError && "Couldn't load that year."}
      minHeight={rows.length * ROW + AXIS}
      legend={
        <div className="legend">
          {ORIGINS.map((origin) => (
            // Square swatches, filled like the bars (a tag draws Unclear hollow).
            <Label key={origin} color={origins[origin].color} variant="square">
              {origins[origin].name}
            </Label>
          ))}
          <AnomalyLegend />
        </div>
      }
      table={{
        columns: [
          { label: "Buoy" },
          { label: "Began" },
          { label: "Ended" },
          { label: "Days", numeric: true },
          { label: "Origin" },
        ],
        rows: () =>
          shown.map((e) => [
            e.buoy_id,
            formatDate(e.start_date),
            formatDate(e.end_date),
            e.duration,
            e.origin ? origins[e.origin].name : "–",
          ]),
      }}
    >
      {(width) => data && <Rows data={data} rows={rows} names={names} events={shown} width={width} />}
    </Chart>
  );
}

interface Cell {
  buoy: string;
  date: Date;
  anomaly: number | null;
  event: HeatwaveEvent | null;
}

interface RowsProps {
  data: Onsets;
  rows: string[]; // buoys east to west
  names: Map<string, string>;
  events: HeatwaveEvent[]; // at this depth, overlapping the year
  width: number;
}

function Rows({ data, rows, names, events, width }: RowsProps) {
  const navigate = useNavigate();
  const options = useMemo((): Plot.PlotOptions => {
    const first = data.dates[0];
    const last = data.dates[data.dates.length - 1];
    const byBuoy = new Map(data.buoys.map((b) => [b.buoy_id, b]));
    const cells: Cell[] = rows.flatMap((buoy) => {
      const days = byBuoy.get(buoy);
      // Each day names its heatwave by its start date.
      const heatwaves = new Map(days?.heatwaves.map((h) => [h.start_date, h]));
      return data.dates.map((date, i) => {
        const start = days?.heatwave[i];
        const event = start ? (heatwaves.get(start) ?? null) : null;
        return { buoy, date: parseDay(date), anomaly: days?.anomaly[i] ?? null, event };
      });
    });
    const unrecorded = rows.filter((buoy) => !byBuoy.get(buoy)?.anomaly.some((a) => a !== null));
    const next = (c: Cell) => new Date(c.date.getTime() + DAY);
    const describe = (c: Cell) =>
      [
        `${c.buoy} ${names.get(c.buoy)}, ${formatDate(c.date)}: ${c.anomaly === null ? "no data" : `${formatSigned(c.anomaly)} vs normal`}`,
        ...(c.event
          ? [
              `Heatwave of ${c.event.duration} days from ${formatDate(c.event.start_date)}`,
              `Origin: ${c.event.origin ? origins[c.event.origin].name : "none"}. Click to open it`,
            ]
          : []),
      ].join("\n");

    const named = width >= NAMED;

    return {
      ...chartDefaults,
      width,
      height: rows.length * ROW + AXIS,
      marginLeft: named ? 170 : chartDefaults.marginLeft,
      marginTop: 0,
      marginBottom: AXIS,
      x: { type: "utc", domain: [parseDay(first), new Date(parseDay(last).getTime() + DAY)], label: null, tickFormat: "%b" },
      y: {
        domain: rows,
        label: null,
        padding: 0,
        tickSize: 0,
        tickFormat: (buoy: string) => (named ? `${buoy}  ${names.get(buoy)}` : buoy),
      },
      marks: [
        Plot.rect(
          cells.filter((c) => c.anomaly !== null),
          { x1: "date", x2: next, y: "buoy", fill: (c: Cell) => anomalyColor(c.anomaly), insetTop: STRIP[0], insetBottom: ROW - STRIP[1] },
        ),
        Plot.rect(events, {
          x1: (e: HeatwaveEvent) => parseDay(maxDay(e.start_date, first)),
          x2: (e: HeatwaveEvent) => new Date(parseDay(minDay(e.end_date, last)).getTime() + DAY),
          y: "buoy_id",
          fill: (e: HeatwaveEvent) => origins[e.origin ?? "unclear"].color,
          insetTop: BAR[0],
          insetBottom: ROW - BAR[1],
        }),
        Plot.text(unrecorded, {
          x: () => parseDay(data.dates[Math.floor(data.dates.length / 2)]),
          y: (buoy: string) => buoy,
          text: () => "no data this year",
          fill: colors.muted,
        }),
        Plot.tip(cells, Plot.pointer({ x: (c: Cell) => new Date(c.date.getTime() + DAY / 2), y: "buoy", title: describe })),
      ],
    };
  }, [data, rows, names, events, width]);

  const onRender = useCallback(
    (plot: PlotElement) => {
      const hovered = () => (plot.value as Cell | null)?.event ?? null;
      const point = () => {
        plot.style.cursor = hovered() ? "pointer" : "";
      };
      const click = () => {
        const event = hovered();
        if (event) navigate(eventPath(event));
      };
      plot.addEventListener("input", point);
      plot.addEventListener("click", click);
      return () => {
        plot.removeEventListener("input", point);
        plot.removeEventListener("click", click);
      };
    },
    [navigate],
  );

  return <PlotFigure options={options} onRender={onRender} />;
}

function AnomalyLegend() {
  const legend = useMemo(
    () =>
      Plot.legend({
        color: { type: "linear", domain: anomalyScale.domain, range: anomalyScale.range, clamp: true, interpolate: "lab" },
        label: "°C vs normal, the strip above each bar",
        width: 240,
        ticks: 5,
        tickFormat: (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0"),
      }),
    [],
  );
  return <span className="anomaly-legend" ref={(node) => node?.replaceChildren(legend)} />;
}
