import { Link, useNavigate } from "react-router";

import { useBuoys, useEvents } from "../api/queries";
import { Swatch } from "../components/StateBadge";
import { earliest, latest } from "../lib/dates";
import { formatDate, formatList } from "../lib/format";
import { buoyStatus, stateLook } from "../lib/state";
import { buoyPath } from "../state/buoyView";

/** Every buoy: its depths, its record, its heatwaves and how it is now, each leading to its page. /buoys */
export function BuoysPage() {
  const buoys = useBuoys();
  const events = useEvents();
  const navigate = useNavigate();

  if (buoys.isPending) return <p className="note">Loading…</p>;
  if (buoys.isError)
    return (
      <p className="note">
        Couldn't reach the API. <button onClick={() => buoys.refetch()}>Try again</button>
      </p>
    );

  return (
    <>
      <section className="intro">
        <p className="kicker">University of Maine moorings</p>
        <h1>The buoys</h1>
        <p className="lead">
          Every buoy the site follows, including the retired ones.
        </p>
      </section>

      <section className="card">
        <div className="table-scroll">
          <table className="buoys">
            <thead>
              <tr>
                <th scope="col">Buoy</th>
                <th scope="col">Depths</th>
                <th scope="col">Record</th>
                <th scope="col" className="num">
                  Heatwaves
                </th>
                <th scope="col">Now</th>
              </tr>
            </thead>
            <tbody>
              {buoys.data.map((buoy) => {
                const href = buoyPath(buoy.id);
                const first = earliest(buoy.series.map((s) => s.first_date));
                const last = latest(buoy.series.map((s) => s.date));
                const heatwaves = events.data?.filter((e) => e.buoy_id === buoy.id).length;
                const status = buoyStatus(buoy.series);
                const quiet = status.condition?.state === "offline" || status.condition?.state === "no_data";
                return (
                  <tr key={buoy.id} className="selectable" onClick={() => navigate(href)}>
                    <th scope="row">
                      <Link to={href} className="row-link" onClick={(e) => e.stopPropagation()}>
                        <span className="code">{buoy.id}</span>
                        <span className="buoy-name">{buoy.name}</span>
                      </Link>
                    </th>
                    <td className="buoy-detail">{formatList(buoy.series.map((s) => s.depth))} m</td>
                    <td className="buoy-detail">{first && last ? `${formatDate(first)} – ${formatDate(last)}` : "–"}</td>
                    <td className="buoy-detail num">
                      {heatwaves === undefined ? (
                        "…"
                      ) : (
                        <Link to={`/events?buoy=${buoy.id}`} onClick={(e) => e.stopPropagation()}>
                          {heatwaves}
                          <span className="phone-only"> heatwaves</span>
                        </Link>
                      )}
                    </td>
                    <td className="buoy-now">
                      {status.condition && (
                        <span className={`state${quiet ? " muted" : ""}`}>
                          <Swatch {...stateLook(status.condition)} />
                          {status.text}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
