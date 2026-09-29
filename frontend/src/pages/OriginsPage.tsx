import { useCallback } from "react";
import { Link, useSearchParams } from "react-router";

import { useBuoys, useEvents, useOriginRules } from "../api/queries";
import { InlineSelect } from "../components/InlineSelect";
import { OriginsByYear } from "../components/OriginsByYear";
import { YearByBuoy } from "../components/YearByBuoy";
import { latest } from "../lib/dates";

const DEFAULT_YEAR = 2021; // the best-studied recent onset: M01 in January, the western Gulf by April
const DEFAULT_DEPTH = 50;
const FIRST_YEAR = 2001; // the first buoy records

/** Where the heat in heatwaves at depth came from, and one year's heatwaves at every buoy. /origins?depth=50&year=2021 */
export function OriginsPage() {
  const buoys = useBuoys();
  const events = useEvents();
  const rules = useOriginRules();
  const [params, setParams] = useSearchParams();

  const depths = rules.data?.depths ?? [20, DEFAULT_DEPTH];
  const lastYear = Number((latest((buoys.data ?? []).flatMap((b) => b.series.map((s) => s.date))) ?? "2026").slice(0, 4));
  const requestedDepth = Number(params.get("depth"));
  const depth = depths.includes(requestedDepth) ? requestedDepth : DEFAULT_DEPTH;
  const requestedYear = Number(params.get("year"));
  const year = Number.isInteger(requestedYear) && requestedYear >= FIRST_YEAR && requestedYear <= lastYear ? requestedYear : DEFAULT_YEAR;
  const years = Array.from({ length: lastYear - FIRST_YEAR + 1 }, (_, i) => lastYear - i);

  const update = useCallback(
    (patch: { depth?: number; year?: number }) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(patch)) next.set(key, String(value));
          return next;
        },
        { replace: true, preventScrollReset: true },
      ),
    [setParams],
  );
  const selectYear = useCallback((y: number) => update({ year: y }), [update]);
  // Both titles choose the depth, each in its own words.
  const depthChoice = {
    label: "Depth",
    value: depth,
    options: depths.map((d) => ({ value: d, label: `${d} m` })),
    onChange: (d: number) => update({ depth: d }),
  };

  return (
    <>
      <section className="intro">
        <p className="kicker">Origins</p>
        <h1>Where the heat came from</h1>
        <p className="lead">
          Heat reaches 20 and 50 m in two ways: warm, salty slope water flowing in through the Northeast Channel, or
          surface heat mixed down by wind or the autumn overturn. Five signals label each heatwave, or leave it Unclear
          when they disagree. <Link to="/about#origin">How the labels are made</Link>.
        </p>
      </section>

      <section className="card">
        <h2>
          Heatwaves at <InlineSelect {...depthChoice} /> each year, by origin
        </h2>
        <p className="caption">
          By the year each began. Click a year to see it below.
        </p>
        {events.isError ? (
          <p className="note">Couldn't load the heatwaves.</p>
        ) : (
          <OriginsByYear events={events.data ?? []} depth={depth} year={year} onSelect={selectYear} />
        )}
      </section>

      <section className="card">
        <h2>
          Every heatwave at <InlineSelect {...depthChoice} /> in{" "}
          <InlineSelect
            label="Year"
            value={year}
            options={years.map((y) => ({ value: y, label: String(y) }))}
            onChange={selectYear}
          />
        </h2>
        <p className="caption">
          Buoys from east to west, in the order slope water reaches them. Click a heatwave for its evidence, or{" "}
          <Link to={`/events?depth=${depth}&year=${year}`}>list them all</Link>.
        </p>
        {buoys.data ? (
          <YearByBuoy year={year} depth={depth} buoys={buoys.data} events={events.data ?? []} />
        ) : (
          <p className="note">Loading…</p>
        )}
      </section>
    </>
  );
}
