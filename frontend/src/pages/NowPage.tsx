import { Navigate, useNavigate, useSearchParams } from "react-router";

import { useBuoys, useMethod } from "../api/queries";
import { BuoyMap } from "../components/BuoyMap";
import { ConditionsTable } from "../components/ConditionsTable";
import { InlineSelect } from "../components/InlineSelect";
import { StateLegend } from "../components/StateBadge";
import { StripesFigure } from "../components/Stripes";
import { formatList, formatOrdinal } from "../lib/format";
import { baselineYears, inWords } from "../lib/method";
import { heatwaveSummary } from "../lib/state";
import { buoyPath, legacyExplorerPath, useBuoyView } from "../state/buoyView";

/** Every buoy's latest daily mean at one depth, on a map and in a table, each leading to its page. /?depth=20 */
export function NowPage() {
  const [params] = useSearchParams();
  const [view, update] = useBuoyView();
  const buoys = useBuoys();
  const method = useMethod();
  const navigate = useNavigate();

  // Links into the explorer this page replaced (/?buoy=F01&from=…) go on to that buoy's page.
  const legacy = legacyExplorerPath(params);
  if (legacy) return <Navigate to={legacy} replace />;

  // The page offers the depths every buoy has. Any other in the URL, such as /?depth=100, shows the first.
  const depths = method.data?.depths ?? [];
  const depth = depths.includes(view.depth) ? view.depth : depths[0];
  const pathFor = (buoy: string) => buoyPath(buoy, { depth });

  return (
    <>
      <section className="intro">
        <p className="kicker">Live from the buoys</p>
        <h1>Marine heatwaves below the surface of the Gulf of Maine</h1>
        {method.data && (
          <p className="lead">
            Daily water temperature at {formatList(method.data.depths)} meters on the University of Maine's buoys,
            against each spot's {baselineYears(method.data)} normal. A marine heatwave is{" "}
            {inWords(method.data.min_duration)} or more days above the {formatOrdinal(method.data.percentile)}{" "}
            percentile for the time of year.
          </p>
        )}
        <StripesFigure />
      </section>

      {buoys.isPending || method.isPending ? (
        <p className="note">Loading…</p>
      ) : buoys.isError || method.isError ? (
        <p className="note">
          Couldn't reach the API.{" "}
          <button onClick={() => Promise.all([buoys.refetch(), method.refetch()])}>Try again</button>
        </p>
      ) : (
        <section className="now">
          <figure className="card map-card">
            <BuoyMap buoys={buoys.data} depth={depth} onSelect={(id) => navigate(pathFor(id))} />
            <figcaption>
              <StateLegend />
            </figcaption>
          </figure>
          <div className="card">
            <h2>
              Latest daily mean at{" "}
              <InlineSelect
                label="Depth"
                value={depth}
                options={depths.map((depth) => ({ value: depth, label: `${depth} m` }))}
                onChange={(depth) => update({ depth })}
              />
            </h2>
            <p className="summary" aria-live="polite">
              {heatwaveSummary(
                buoys.data.flatMap((b) => b.series.filter((s) => s.depth === depth)),
                depth,
              )}
            </p>
            <ConditionsTable buoys={buoys.data} depth={depth} pathFor={pathFor} />
          </div>
        </section>
      )}
    </>
  );
}
