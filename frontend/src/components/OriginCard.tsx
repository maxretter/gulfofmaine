import * as Plot from "@observablehq/plot";
import { useMemo } from "react";

import type { Buoy, EventDetail, Evidence, Onset, OriginRules, Signal, SignalDay } from "../api/types";
import { chartDefaults } from "../lib/chart";
import { categories, colors, origins } from "../lib/colors";
import { addDays, formatDay, parseDay } from "../lib/dates";
import { formatDate, formatSigned } from "../lib/format";
import { eastToWest, reading, sides, signals, verdict } from "../lib/origin";
import { Chart } from "./Chart";
import { Label, OriginLabel, VoteLabel } from "./Label";
import { PlotFigure } from "./PlotFigure";
import { TableToggle } from "./TableToggle";

interface Day extends Omit<SignalDay, "date"> {
  date: Date;
}

interface CardProps {
  detail: EventDetail;
  rules: OriginRules;
}

/** The five signals behind the origin label, each with its reading, its vote and a small chart. */
export function OriginCard({ detail, rules, buoys }: CardProps & { buoys: Buoy[] }) {
  const evidence = detail.evidence!;
  // Kept while the heatwave is, so the page's other renders (one per reading the live feed brings) redraw no chart.
  const days = useMemo(() => detail.signals.map((d) => ({ ...d, date: parseDay(d.date) })), [detail.signals]);
  const onset = useMemo(() => parseDay(detail.start_date), [detail.start_date]);

  return (
    <section className="card">
      <div className="detail-head">
        <h2>Offshore or surface?</h2>
        <OriginLabel origin={detail.origin!} />
      </div>
      <p className="caption">
        {verdict(detail.origin!, evidence.votes, rules.margin)} The dotted line marks the onset.
      </p>
      <div className="signals">
        {signals(rules).map(({ key, name }) => (
          <div className="signal" key={key}>
            <div className="signal-head">
              <h3>{name}</h3>
              <VoteLabel vote={evidence.votes[key]} />
            </div>
            <p className="signal-reading">{reading(key, evidence, rules, detail.depth, detail.buoy_id)}</p>
            <SignalChart signal={key} days={days} onset={onset} detail={detail} rules={rules} buoys={buoys} />
          </div>
        ))}
      </div>
      <SignalTable days={days} depth={detail.depth} deepBuoy={rules.deep_buoy} />
    </section>
  );
}

interface SignalChartProps extends CardProps {
  signal: Signal;
  days: Day[];
  onset: Date;
  buoys: Buoy[];
}

function SignalChart({ signal, days, onset, detail, rules, buoys }: SignalChartProps) {
  if (signal === "onset_order") return <OnsetOrder detail={detail} rules={rules} buoys={buoys} />;
  if (!hasData(signal, detail.evidence!)) return null; // the reading says what's missing
  return (
    <Chart className="chart" minHeight={130}>
      {(width) => <WindowChart signal={signal} days={days} onset={onset} detail={detail} rules={rules} width={width} />}
    </Chart>
  );
}

const nextDay = (day: Date) => new Date(day.getTime() + 86_400_000);

function hasData(signal: Signal, evidence: Evidence): boolean {
  switch (signal) {
    case "salinity":
      return evidence.salinity_anomaly !== null;
    case "surface_heatwave":
      return evidence.surface_heatwave_days !== null;
    case "stratification":
      return evidence.stratification_before !== null && evidence.stratification_after !== null;
    case "deep":
      return evidence.deep_heatwave_days !== null;
    case "onset_order":
      return true;
  }
}

// Small charts share a frame: dates as "Apr 14", and a right margin for labeling reference lines.
const frame = { marginTop: 22, marginRight: 64, tickFormat: "%b %-d" };

function WindowChart({ signal, days, onset, detail, rules, width }: Omit<SignalChartProps, "buoys"> & { width: number }) {
  const options = useMemo((): Plot.PlotOptions => {
    const first = days[0].date;
    const last = nextDay(days[days.length - 1].date);
    const before = { x1: first, x2: onset }; // the 30 days before onset
    const onsetRule = Plot.ruleX([onset], { stroke: colors.ink, strokeDasharray: "2,3" });
    const base = {
      ...chartDefaults,
      width,
      height: 130,
      marginTop: frame.marginTop,
      marginRight: frame.marginRight,
      x: { type: "utc" as const, domain: [first, last], label: null, ticks: "2 weeks", tickFormat: frame.tickFormat },
    };
    const tip = (y: keyof Day, format: (value: number) => string) =>
      Plot.tip(
        days.filter((d) => d[y] !== null),
        Plot.pointerX({ x: "date", y, title: (d: Day) => `${formatDate(d.date)}\n${format(d[y] as number)}` }),
      );
    // Temperature against normal somewhere else in the water, its heatwave days shaded and the days before onset,
    // which the vote reads, in gray.
    const heatwavesThere = (anomaly: "surface_anomaly" | "deep_anomaly", heatwave: "surface_heatwave" | "deep_heatwave") => ({
      ...base,
      y: { label: "°C vs normal", grid: true, nice: true },
      marks: [
        Plot.rectX([before], { ...before, fill: colors.neutral }),
        Plot.rectX(
          days.filter((d) => d[heatwave]),
          { x1: (d: Day) => d.date, x2: (d: Day) => nextDay(d.date), fill: categories[1].color, fillOpacity: 0.35 },
        ),
        Plot.ruleY([0], { stroke: colors.axis }),
        onsetRule,
        Plot.lineY(days, { x: "date", y: anomaly, stroke: colors.observed, strokeWidth: 2 }),
        Plot.tip(
          days.filter((d) => d[anomaly] !== null),
          Plot.pointerX({
            x: "date",
            y: anomaly,
            title: (d: Day) => `${formatDate(d.date)}\n${formatSigned(d[anomaly])}${d[heatwave] ? "\nIn a heatwave" : ""}`,
          }),
        ),
      ],
    });
    // A dashed reference line, named in the right margin, clear of the data.
    const threshold = (value: number, text: string, side: "above" | "below") => [
      Plot.ruleY([value], { stroke: colors.ink2, strokeDasharray: "4,3" }),
      Plot.text([value], {
        x: last,
        y: (v: number) => v,
        text: () => text,
        textAnchor: "start",
        lineAnchor: side === "above" ? "bottom" : "top",
        dx: 6,
        dy: side === "above" ? -1 : 1,
        fill: colors.ink2,
      }),
    ];

    switch (signal) {
      case "salinity":
        return {
          ...base,
          y: { label: "vs normal", grid: true, nice: true },
          marks: [
            // Between the two thresholds, salinity doesn't vote.
            Plot.rect([rules], { y1: rules.fresh, y2: rules.salty, fill: colors.neutral }),
            ...threshold(rules.salty, "offshore", "above"),
            ...threshold(rules.fresh, "surface", "below"),
            onsetRule,
            Plot.lineY(days, { x: "date", y: "salinity_anomaly", stroke: colors.observed, strokeWidth: 2 }),
            tip("salinity_anomaly", (v) => formatSigned(v, "", 2)),
          ],
        };
      case "surface_heatwave":
        return heatwavesThere("surface_anomaly", "surface_heatwave");
      case "stratification":
        return {
          ...base,
          y: { label: "°C", grid: true, nice: true },
          marks: [
            Plot.ruleY([0], { stroke: colors.axis }),
            ...threshold(rules.mixed, formatSigned(rules.mixed), "below"),
            onsetRule,
            Plot.lineY(days, { x: "date", y: "stratification", stroke: colors.observed, strokeWidth: 2 }),
            // The two means the vote compares.
            Plot.ruleY(detail.evidence!.stratification_before === null ? [] : [detail.evidence!.stratification_before], {
              x1: first,
              x2: onset,
              stroke: colors.ink,
              strokeWidth: 2,
            }),
            Plot.ruleY(detail.evidence!.stratification_after === null ? [] : [detail.evidence!.stratification_after], {
              x1: onset,
              x2: last,
              stroke: colors.ink,
              strokeWidth: 2,
            }),
            tip("stratification", (v) => formatSigned(v)),
          ],
        };
      case "deep":
        return heatwavesThere("deep_anomaly", "deep_heatwave");
      default:
        return base;
    }
  }, [signal, days, onset, detail, rules, width]);

  return <PlotFigure options={options} />;
}

const fills = { offshore: origins.offshore.color, western: origins.surface.color };
const color = (onset: Onset) => (onset.group ? fills[onset.group] : colors.muted);

/** Each buoy's heatwave onsets at this depth in the lookback, east at the top; the heatwave's own buoy on neither side. */
function OnsetOrder({ detail, rules, buoys }: CardProps & { buoys: Buoy[] }) {
  // Kept while the order is: the buoys come anew with every reading the live feed brings, and the same order in a new
  // list would redraw the chart.
  const ids = eastToWest(buoys, detail.depth)
    .map((b) => b.id)
    .join();
  const order = useMemo(() => (ids ? ids.split(",") : []), [ids]);
  const compared = sides(rules, detail.buoy_id);
  return (
    <Chart
      className="chart"
      minHeight={40 + order.length * 18}
      legend={
        <div className="legend">
          <Label color={fills.offshore}>{compared.offshore.join(", ")}: eastern side</Label>
          <Label color={fills.western}>{compared.western.join(", ")}: western side</Label>
        </div>
      }
      table={{
        columns: [{ label: "Buoy" }, { label: "Heatwave began" }, { label: "Side" }],
        rows: () => detail.onsets.map((o) => [o.buoy_id, formatDate(o.date), o.group ?? "–"]),
      }}
    >
      {(width) => <OnsetDots detail={detail} rules={rules} order={order} color={color} width={width} />}
    </Chart>
  );
}

interface OnsetDotsProps extends CardProps {
  order: string[];
  color: (onset: Onset) => string;
  width: number;
}

function OnsetDots({ detail, rules, order, color, width }: OnsetDotsProps) {
  const options = useMemo((): Plot.PlotOptions => {
    const onset = parseDay(detail.start_date);
    const earliest = parseDay(addDays(detail.start_date, -rules.lookback));
    const points = detail.onsets.map((o) => ({ ...o, day: parseDay(o.date) }));
    return {
      ...chartDefaults,
      width,
      height: 40 + order.length * 18,
      marginTop: 8,
      marginRight: frame.marginRight,
      x: { type: "utc", domain: [earliest, nextDay(nextDay(onset))], label: null, ticks: "month", tickFormat: frame.tickFormat },
      y: { domain: order, label: null, grid: true },
      marks: [
        Plot.ruleX([onset], { stroke: colors.ink, strokeDasharray: "2,3" }),
        Plot.dot(points, { x: "day", y: "buoy_id", r: 5, fill: color, stroke: colors.surface, strokeWidth: 2 }),
        Plot.tip(points, Plot.pointer({ x: "day", y: "buoy_id", title: (o: Onset) => `${o.buoy_id}\nBegan ${formatDate(o.date)}` })),
      ],
    };
  }, [detail, rules, order, color, width]);
  return <PlotFigure options={options} />;
}

/** The table twin of every signal chart above, day by day. */
function SignalTable({ days, depth, deepBuoy }: { days: Day[]; depth: number; deepBuoy: string }) {
  const yes = (value: boolean) => (value ? "yes" : "");
  return (
    <TableToggle
      columns={[
          { label: "Date" },
          { label: `${depth} m vs normal`, numeric: true },
          { label: "Salinity vs normal", numeric: true },
          { label: `1 m minus ${depth} m`, numeric: true },
          { label: "1 m vs normal", numeric: true },
          { label: "Heatwave at 1 m" },
          { label: `${deepBuoy} deep vs normal`, numeric: true },
          { label: `${deepBuoy} deep heatwave` },
      ]}
      rows={() =>
        days.map((d) => [
          formatDay(d.date),
          formatSigned(d.anomaly),
          formatSigned(d.salinity_anomaly, "", 2),
          formatSigned(d.stratification),
          formatSigned(d.surface_anomaly),
          yes(d.surface_heatwave),
          formatSigned(d.deep_anomaly),
          yes(d.deep_heatwave),
        ])
      }
    />
  );
}
