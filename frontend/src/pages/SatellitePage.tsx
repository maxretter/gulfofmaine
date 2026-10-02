import { Link, useNavigate } from "react-router";

import { useAgreements, useBuoys, useMethod } from "../api/queries";
import type { Agreement } from "../api/types";
import { SatelliteMisses } from "../components/SatelliteMisses";
import { eachCompared, missedShare } from "../lib/agreement";
import { formatList, formatPercent } from "../lib/format";
import { buoyPath } from "../state/buoyView";

/** Heatwave days at a depth, and the share of them the satellite showed no heatwave for. */
function summarize(rows: Agreement[]) {
  const days = rows.reduce((sum, row) => sum + row.both + row.buoy_only, 0);
  return { days, share: missedShare(rows) };
}

/** How often a buoy's heatwave had no heatwave at the surface above in the satellite record. /satellite */
export function SatellitePage() {
  const buoys = useBuoys();
  const method = useMethod();
  const navigate = useNavigate();
  // The map's depths. The shallowest is first in the table, but last among the figures: it's the yardstick for the
  // others.
  const depths = method.data?.depths ?? [];
  const agreements = useAgreements(depths);
  const loading = method.isPending || agreements.isPending;
  const failed = method.isError || agreements.isError;
  const rows = (depth: number) => agreements.byDepth[depths.indexOf(depth)] ?? [];
  const empty = !loading && !failed && agreements.byDepth.every((each) => each.length === 0);
  const compared = (buoys.data ?? []).filter((buoy) => depths.some((d) => rows(d).some((r) => r.buoy_id === buoy.id)));

  return (
    <>
      <section className="intro">
        <p className="kicker">Satellite gap</p>
        <h1>What the satellite misses</h1>
        <p className="lead">
          {eachCompared(buoys.data)} set beside NOAA's satellite record of sea surface temperature in the nearest grid
          cell. On the days a buoy logged a heatwave, did the satellite show one at the surface?{" "}
          <Link to="/about#satellite">How the comparison is made</Link>.
        </p>
      </section>

      {failed ? (
        <p className="note">Couldn't load the satellite comparison.</p>
      ) : method.isPending ? (
        <p className="note">Loading…</p>
      ) : empty ? (
        <p className="note">
          No satellite comparison yet: the satellite record hasn't been loaded. The sync job reads it from NOAA's
          CoastWatch ERDDAP every hour.
        </p>
      ) : (
        <>
          <div className="tiles stats">
            {depths.toReversed().map((depth) => {
              const { days, share } = summarize(rows(depth));
              return (
                <div className="tile" key={depth}>
                  <p className="tile-label">At {depth} m</p>
                  <p className="tile-value">{loading ? "…" : share === null ? "–" : formatPercent(share)}</p>
                  <p className="tile-delta">
                    of {loading ? "the" : days.toLocaleString()} heatwave days had no heatwave at the surface above.
                    {depth === depths[0] && " The buoys' shallowest depth, to compare the others with."}
                  </p>
                </div>
              );
            })}
          </div>

          <section className="card">
            <h2>Heatwave days at {formatList(depths.slice(1))} m, every buoy together</h2>
            <SatelliteMisses />
          </section>

          {compared.length > 0 && (
            <section className="card">
              <h2>At each buoy</h2>
              <p className="caption">
                The share of heatwave days with no satellite heatwave above.
              </p>
              <div className="table-scroll">
                <table className="shares">
                  <thead>
                    <tr>
                      <th scope="col">Buoy</th>
                      {depths.map((depth) => (
                        <th scope="col" className="num" key={depth}>
                          {depth} m
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {compared.map((buoy) => {
                      const href = buoyPath(buoy.id, { depth: depths.at(-1) });
                      return (
                        <tr key={buoy.id} className="selectable" onClick={() => navigate(href)}>
                          <th scope="row">
                            <Link to={href} className="row-link" onClick={(e) => e.stopPropagation()}>
                              <span className="code">{buoy.id}</span>
                              <span className="buoy-name">{buoy.name}</span>
                            </Link>
                          </th>
                          {depths.map((depth) => {
                            const { days, share } = summarize(rows(depth).filter((r) => r.buoy_id === buoy.id));
                            return (
                              <td className="num" key={depth}>
                                {share === null ? (
                                  <span className="muted">–</span>
                                ) : (
                                  <>
                                    {formatPercent(share)}
                                    <span className="secondary">of {days.toLocaleString()} days</span>
                                  </>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}
