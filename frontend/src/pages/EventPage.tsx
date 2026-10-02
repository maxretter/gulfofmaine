import { useMemo } from "react";
import { Link, useParams } from "react-router";

import { isNotFound, useBuoys, useEvent, useEvents, useOriginRules } from "../api/queries";
import type { HeatwaveEvent } from "../api/types";
import { DepthCharts, SeriesLegend } from "../components/DepthCharts";
import { AtTheSameTime, EventFigures } from "../components/EventContext";
import { CategoryLabel, OriginLabel } from "../components/Label";
import { OriginCard } from "../components/OriginCard";
import { TSCard } from "../components/TSDiagram";
import { isDay } from "../lib/dates";
import { eventRange } from "../lib/events";
import { heatwavePeriodPath } from "../state/buoyView";

const NO_EVENTS: HeatwaveEvent[] = [];

/** One heatwave: what it was, and the evidence for where its heat came from. /events/A01/50/2021-04-14 */
export function EventPage() {
  const params = useParams();
  const buoyId = (params.buoy ?? "").toUpperCase();
  const depth = Number(params.depth);
  const start = params.start ?? "";
  const valid = /^[A-Z0-9]{2,8}$/.test(buoyId) && Number.isInteger(depth) && isDay(start);
  const event = useEvent(buoyId, depth, start);
  const buoys = useBuoys();
  const events = useEvents();
  const rules = useOriginRules();
  // Kept as long as the heatwaves are: the page renders again with each reading the live feed brings, and a new list,
  // even of the same heatwaves, would redraw every depth's chart.
  const eventBuoy = event.data?.buoy_id;
  const buoyEvents = useMemo(
    () => events.data?.filter((e) => e.buoy_id === eventBuoy) ?? NO_EVENTS,
    [events.data, eventBuoy],
  );

  if (!valid || isNotFound(event.error)) return <NotFoundEvent />;
  if (event.isPending || rules.isPending) return <p className="note">Loading…</p>;
  if (event.isError || rules.isError) return <p className="note">Couldn't load this heatwave.</p>;

  const detail = event.data;
  const buoy = buoys.data?.find((b) => b.id === detail.buoy_id);
  const period = eventRange(detail);
  return (
    <>
      <section className="intro">
        <p className="kicker">
          <Link to="/events">Heatwaves</Link>
          <span className="kicker-sep" aria-hidden="true">
            ·
          </span>
          {detail.buoy_id}
        </p>
        <h1>
          {buoy?.name ?? detail.buoy_id}, {detail.depth} m
        </h1>
        <div className="event-labels">
          <CategoryLabel category={detail.category} />
          {detail.origin ? (
            <OriginLabel origin={detail.origin} />
          ) : (
            <span className="muted">
              Origins are labeled at {rules.data.depths.join(" and ")} m only. <Link to="/about#origin">Why</Link>
            </span>
          )}
          <Link to={heatwavePeriodPath(detail)}>See it on {detail.buoy_id}'s record</Link>
        </div>
      </section>

      <EventFigures event={detail} events={events.data} />

      {buoy && (
        <section className="card">
          <h2>Through the heatwave, at every depth</h2>
          <SeriesLegend buoy={buoy} />
          <DepthCharts buoy={buoy} from={period.from} to={period.to} events={buoyEvents} />
        </section>
      )}

      {detail.origin && detail.evidence && (
        <>
          <OriginCard detail={detail} rules={rules.data} buoys={buoys.data ?? []} />
          <TSCard detail={detail} rules={rules.data} />
        </>
      )}

      {events.data && buoys.data && <AtTheSameTime event={detail} events={events.data} buoys={buoys.data} />}
    </>
  );
}

function NotFoundEvent() {
  return (
    <section className="intro">
      <h1>No such heatwave</h1>
      <p className="lead">
        <Link to="/events">See every heatwave</Link>
      </p>
    </section>
  );
}
