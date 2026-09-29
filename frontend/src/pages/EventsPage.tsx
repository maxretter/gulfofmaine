import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { useBuoys, useEvents } from "../api/queries";
import type { Origin } from "../api/types";
import { CategoryLabel, OriginLabel } from "../components/Label";
import { categories, origins } from "../lib/colors";
import {
  type EventFilters,
  eventPath,
  filterEvents,
  parseEventParams,
  type SortKey,
  sortEvents,
  toEventParams,
} from "../lib/events";
import { formatDate, formatSigned } from "../lib/format";

const PAGE = 100;

export function EventsPage() {
  const [params, setParams] = useSearchParams();
  const { filters, sort } = parseEventParams(params);
  const events = useEvents();
  const buoys = useBuoys();
  const navigate = useNavigate();
  const [shown, setShown] = useState(PAGE);

  const setFilters = (patch: Partial<EventFilters>) => {
    setParams(toEventParams({ ...filters, ...patch }, sort), { replace: true, preventScrollReset: true });
    setShown(PAGE);
  };
  const setSort = (key: SortKey) =>
    setParams(toEventParams(filters, { key, descending: sort.key === key ? !sort.descending : true }), {
      replace: true,
      preventScrollReset: true,
    });

  if (events.isPending) return <p className="note">Loading…</p>;
  if (events.isError) return <p className="note">Couldn't load the heatwaves.</p>;

  const matching = sortEvents(filterEvents(events.data, filters), sort);
  const years = [...new Set(events.data.map((e) => Number(e.start_date.slice(0, 4))))].sort((a, b) => b - a);
  const depths = [...new Set(events.data.map((e) => e.depth))].sort((a, b) => a - b);
  const totalDays = matching.reduce((sum, e) => sum + e.duration, 0);
  const buoyCount = new Set(events.data.map((e) => e.buoy_id)).size;

  const header = (label: string, key: SortKey, numeric = false) => (
    <th
      scope="col"
      className={numeric ? "num" : undefined}
      aria-sort={sort.key === key ? (sort.descending ? "descending" : "ascending") : undefined}
    >
      <button type="button" className="sort-button" onClick={() => setSort(key)}>
        {label}
        <span aria-hidden="true">{sort.key === key ? (sort.descending ? " ↓" : " ↑") : ""}</span>
      </button>
    </th>
  );

  return (
    <>
      <section className="intro">
        <h1>Every heatwave on record</h1>
        <p className="lead">
          All {events.data.length} marine heatwaves detected at the {buoyCount} buoys since 2001. Filter and sort them,
          then open one to see where its heat came from.
        </p>
      </section>

      <div className="filters">
        <label>
          <span className="filter-label">Buoy</span>
          <select
            className="select"
            value={filters.buoy ?? ""}
            onChange={(e) => setFilters({ buoy: e.target.value || null })}
          >
            <option value="">All</option>
            {buoys.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.id} {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="filter-label">Depth</span>
          <select
            className="select"
            value={filters.depth ?? ""}
            onChange={(e) => setFilters({ depth: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">All</option>
            {depths.map((d) => (
              <option key={d} value={d}>
                {d} m
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="filter-label">Year</span>
          <select
            className="select"
            value={filters.year ?? ""}
            onChange={(e) => setFilters({ year: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">All</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="filter-label">At least</span>
          <select
            className="select"
            value={filters.minCategory}
            onChange={(e) => setFilters({ minCategory: Number(e.target.value) })}
          >
            {Object.entries(categories).map(([n, c]) => (
              <option key={n} value={n}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="filter-label">Origin</span>
          <select
            className="select"
            value={filters.origin ?? ""}
            onChange={(e) => setFilters({ origin: (e.target.value || null) as Origin | null })}
          >
            <option value="">All</option>
            {Object.entries(origins).map(([key, { name }]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {params.size > 0 && (
          <button type="button" className="link-button" onClick={() => setParams({}, { replace: true })}>
            Reset
          </button>
        )}
      </div>

      <section className="card">
        <p className="caption" aria-live="polite">
          {matching.length} heatwave{matching.length === 1 ? "" : "s"}, {totalDays.toLocaleString()} days in all.
          Intensity is degrees above the normal for that day. Only heatwaves at 20 and 50 m get an origin.
        </p>
        <div className="table-scroll">
          <table className="events">
            <thead>
              <tr>
                <th scope="col">Buoy</th>
                <th scope="col">Depth</th>
                {header("Start", "start_date")}
                <th scope="col">End</th>
                {header("Days", "duration", true)}
                {header("Peak", "max_intensity", true)}
                <th scope="col" className="num">
                  Mean
                </th>
                {header("Category", "category")}
                <th scope="col">Origin</th>
              </tr>
            </thead>
            <tbody>
              {matching.slice(0, shown).map((event) => {
                const href = eventPath(event);
                return (
                  <tr
                    key={`${event.buoy_id}-${event.depth}-${event.start_date}`}
                    className="selectable"
                    onClick={() => navigate(href)}
                  >
                    <td>
                      <Link to={href} className="code" onClick={(e) => e.stopPropagation()}>
                        {event.buoy_id}
                      </Link>
                    </td>
                    <td>{event.depth} m</td>
                    <td>{formatDate(event.start_date)}</td>
                    <td>{formatDate(event.end_date)}</td>
                    <td className="num">{event.duration}</td>
                    <td className="num">{formatSigned(event.max_intensity)}</td>
                    <td className="num">{formatSigned(event.mean_intensity)}</td>
                    <td>
                      <CategoryLabel category={event.category} />
                    </td>
                    <td>{event.origin ? <OriginLabel origin={event.origin} /> : <span className="muted">–</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {matching.length > shown && (
          <button type="button" className="link-button" onClick={() => setShown(matching.length)}>
            Show all {matching.length}
          </button>
        )}
      </section>
    </>
  );
}
