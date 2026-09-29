import { Navigate, useNavigate, useSearchParams } from "react-router";

import { useBuoys } from "../api/queries";
import { BuoyMap } from "../components/BuoyMap";
import { ConditionsTable } from "../components/ConditionsTable";
import { StateLegend } from "../components/StateBadge";
import { heatwaveSummary } from "../lib/state";
import { buoyPath, DEPTHS, legacyExplorerPath, useBuoyView } from "../state/buoyView";

/** Every buoy's latest daily mean at one depth, on a map and in a table, each leading to its page. /?depth=20 */
export function NowPage() {
  const [params] = useSearchParams();
  const [view, update] = useBuoyView();
  const buoys = useBuoys();
  const navigate = useNavigate();

  // Links into the explorer this page replaced (/?buoy=F01&from=…) go on to that buoy's page.
  const legacy = legacyExplorerPath(params);
  if (legacy) return <Navigate to={legacy} replace />;

  const pathFor = (buoy: string) => buoyPath(buoy, { depth: view.depth });

  return (
    <>
      <section className="intro">
        <h1>Marine heatwaves below the surface of the Gulf of Maine</h1>
        <p className="lead">
          The latest daily water temperature at 1, 20 and 50 metres on the University of Maine's buoys, against each
          spot's 2003–2022 normal. A marine heatwave is five or more days warmer than the 90th percentile for the time
          of year. Updated every 10 minutes from NERACOOS.
        </p>
      </section>

      <div className="toolbar">
        <div className="filters" role="group" aria-label="Depth">
          <span className="filter-label">Depth</span>
          <div className="segmented">
            {DEPTHS.map((depth) => (
              <button key={depth} type="button" aria-pressed={depth === view.depth} onClick={() => update({ depth })}>
                {depth} m
              </button>
            ))}
          </div>
        </div>
        {buoys.data && (
          <p className="summary" aria-live="polite">
            {heatwaveSummary(
              buoys.data.flatMap((b) => b.series.filter((s) => s.depth === view.depth)),
              view.depth,
            )}
          </p>
        )}
      </div>

      {buoys.isPending ? (
        <p className="note">Loading…</p>
      ) : buoys.isError ? (
        <p className="note">
          Couldn't reach the API. <button onClick={() => buoys.refetch()}>Try again</button>
        </p>
      ) : (
        <section className="now">
          <figure className="card map-card">
            <BuoyMap buoys={buoys.data} depth={view.depth} onSelect={(id) => navigate(pathFor(id))} />
            <figcaption>
              <StateLegend />
            </figcaption>
          </figure>
          <div className="card">
            <h2>Latest daily mean at {view.depth} m</h2>
            <p className="caption">Choose a buoy, here or on the map, for its whole record and every heatwave in it.</p>
            <ConditionsTable buoys={buoys.data} depth={view.depth} pathFor={pathFor} />
          </div>
        </section>
      )}
    </>
  );
}
