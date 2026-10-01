import * as Plot from "@observablehq/plot";
import { useMemo } from "react";

import { type DayPoint, isNotFound, useDaily } from "../api/queries";
import type { EventDetail, OriginRules } from "../api/types";
import { chartDefaults } from "../lib/chart";
import { colors } from "../lib/colors";
import { addDays, formatDay } from "../lib/dates";
import { formatDate, formatTemp } from "../lib/format";
import { Chart } from "./Chart";
import { Label } from "./Label";
import { PlotFigure } from "./PlotFigure";

interface CardProps {
  detail: EventDetail;
  rules: OriginRules;
}

interface TSPoint {
  date: Date;
  temperature: number;
  salinity: number;
  after: boolean; // on or after the onset
}

/** Temperature against salinity at the event's depth over the evidence window, before and after onset. */
export function TSCard({ detail, rules }: CardProps) {
  const from = addDays(detail.start_date, -rules.before);
  const to = addDays(detail.start_date, rules.after);
  const temperature = useDaily(detail.buoy_id, detail.depth, from, to);
  const salinity = useDaily(detail.buoy_id, detail.depth, from, to, "salinity");
  // Temperature has a normal here, since the heatwave was found against it; salinity may not have one yet.
  const noSalinityNormal = isNotFound(salinity.error);
  const { points, normal } = useMemo(() => pair(temperature.data, salinity.data, detail.start_date), [
    temperature.data,
    salinity.data,
    detail.start_date,
  ]);

  return (
    <section className="card">
      <h2>Temperature and salinity at {detail.depth} m</h2>
      <p className="caption">
        Each dot is a day around the onset. The dashed line is the normal for the same days.
      </p>
      <Chart
        className="chart"
        loading={temperature.isPending || salinity.isPending}
        error={
          (temperature.isError || (salinity.isError && !noSalinityNormal)) && "Couldn't load the temperature and salinity."
        }
        empty={noSalinityNormal && `No normal for salinity at ${detail.depth} m, so it isn't charted.`}
        minHeight={320}
        legend={
          <div className="legend">
            <Label color={colors.muted}>Before onset</Label>
            <Label color={colors.observed}>From onset</Label>
            <span className="key">
              <span className="line dashed" style={{ borderColor: colors.ink2 }} aria-hidden="true" />
              Normal
            </span>
          </div>
        }
        table={{
          columns: [
            { label: "Date" },
            { label: "Temperature", numeric: true },
            { label: "Salinity", numeric: true },
            { label: "Period" },
          ],
          rows: () =>
            points.map((p) => [
              formatDay(p.date),
              formatTemp(p.temperature),
              p.salinity.toFixed(2),
              p.after ? "from onset" : "before",
            ]),
        }}
      >
        {(width) =>
          points.length > 0 ? (
            <TSDiagram points={points} normal={normal} width={width} />
          ) : (
            temperature.data && salinity.data && <p className="note">No days with both temperature and salinity.</p>
          )
        }
      </Chart>
    </section>
  );
}

/** Days with both a temperature and a salinity, and the normal for each day of the window. */
function pair(temperature: DayPoint[] | undefined, salinity: DayPoint[] | undefined, onset: string) {
  if (!temperature || !salinity) return { points: [], normal: [] };
  const salt = new Map(salinity.map((d) => [formatDay(d.date), d]));
  const points: TSPoint[] = [];
  const normal: { temperature: number; salinity: number }[] = [];
  for (const day of temperature) {
    const s = salt.get(formatDay(day.date));
    if (!s) continue;
    normal.push({ temperature: day.climatology, salinity: s.climatology });
    if (day.value !== null && s.value !== null)
      points.push({ date: day.date, temperature: day.value, salinity: s.value, after: formatDay(day.date) >= onset });
  }
  return { points, normal };
}

function TSDiagram({ points, normal, width }: { points: TSPoint[]; normal: { temperature: number; salinity: number }[]; width: number }) {
  const options = useMemo(
    (): Plot.PlotOptions => ({
      ...chartDefaults,
      width: Math.min(width, 640),
      height: 320,
      marginBottom: 36,
      x: { label: "Salinity (practical salinity scale)", grid: true, nice: true },
      y: { label: "°C", grid: true, nice: true },
      marks: [
        Plot.line(normal, { x: "salinity", y: "temperature", stroke: colors.ink2, strokeDasharray: "4,3" }),
        Plot.line(points, { x: "salinity", y: "temperature", stroke: colors.axis, strokeWidth: 1 }),
        Plot.dot(points, {
          x: "salinity",
          y: "temperature",
          r: 4,
          fill: (p: TSPoint) => (p.after ? colors.observed : colors.muted),
          stroke: colors.surface,
          strokeWidth: 1,
        }),
        Plot.tip(
          points,
          Plot.pointer({
            x: "salinity",
            y: "temperature",
            title: (p: TSPoint) => `${formatDate(p.date)}\n${formatTemp(p.temperature)}, salinity ${p.salinity.toFixed(2)}`,
          }),
        ),
      ],
    }),
    [points, normal, width],
  );
  return <PlotFigure options={options} />;
}
