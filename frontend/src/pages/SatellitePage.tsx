import type { UseQueryResult } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";

import { useAgreement, useBuoys } from "../api/queries";
import type { Agreement } from "../api/types";
import { SatelliteMisses } from "../components/SatelliteMisses";
import { missedShare } from "../lib/agreement";
import { formatPercent } from "../lib/format";
import { buoyPath } from "../state/buoyView";

/** Heatwave days at a depth, and the share of them the satellite showed no heatwave for. */
function summarize(rows: Agreement[]) {
  const days = rows.reduce((sum, row) => sum + row.both + row.buoy_only, 0);
  return { days, share: missedShare(rows) };
}

/** How often a buoy's heatwave had no heatwave at the surface above in the satellite record. /satellite */
export function SatellitePage() {
  const buoys = useBuoys();
  const navigate = useNavigate();
  // 1 m first in the table, but last among the figures: it's the yardstick for the other two.
  const depths: [number, UseQueryResult<Agreement[]>][] = [
    [1, useAgreement(1)],
    [20, useAgreement(20)],
    [50, useAgreement(50)],
  ];
  const loading = depths.some(([, result]) => result.isPending);
  const failed = depths.some(([, result]) => result.isError);
  const rows = (depth: number) => depths.find(([d]) => d === depth)?.[1].data ?? [];
  const empty = !loading && !failed && depths.every(([, result]) => result.data?.length === 0);
  const compared = (buoys.data ?? []).filter((buoy) => depths.some(([d]) => rows(d).some((r) => r.buoy_id === buoy.id)));

  return (
    <>
      <section className="intro">
        <h1>What the satellite misses</h1>
        <p className="lead">
          Most heatwave monitoring in the Gulf of Maine uses satellite sea surface temperature, which sees only the top
          millimeters of the water. Each buoy here is compared with NOAA's OISST, the satellite record behind GMRI's
          Gulf of Maine temperature reports, in the nearest grid cell: on the days a buoy logged a heatwave, did the
          satellite show one at the surface above? <Link to="/methods#satellite">How the comparison is made</Link>.
        </p>
      </section>

      {failed ? (
        <p className="note">Couldn't load the satellite comparison.</p>
      ) : empty ? (
        <p className="note">
          No satellite comparison yet: the satellite record hasn't been loaded. The sync job reads it from NOAA's
          CoastWatch ERDDAP every hour.
        </p>
      ) : (
        <>
          <div className="tiles stats">
            {[50, 20, 1].map((depth) => {
              const { days, share } = summarize(rows(depth));
              return (
                <div className="tile" key={depth}>
                  <p className="tile-label">At {depth} m</p>
                  <p className="tile-value">{loading ? "…" : share === null ? "–" : formatPercent(share)}</p>
                  <p className="tile-delta">
                    of {loading ? "the" : days.toLocaleString()} heatwave days had no heatwave at the surface above.
                    {depth === 1 &&
                      " Buoy and satellite see nearly the same water here, so this is how often two surface records disagree anyway."}
                  </p>
                </div>
              );
            })}
          </div>

          <section className="card">
            <h2>Heatwave days at 20 and 50 m, every buoy together</h2>
            <p className="caption">
              Each year's heatwave days at depth, summed over the buoys and split by whether the satellite record also
              showed a heatwave at the surface above. Only days with data from both count.
            </p>
            <SatelliteMisses />
          </section>

          {compared.length > 0 && (
            <section className="card">
              <h2>At each buoy</h2>
              <p className="caption">
                The share of each buoy's heatwave days with no satellite heatwave above. Choose a buoy for its record.
              </p>
              <div className="table-scroll">
                <table className="shares">
                  <thead>
                    <tr>
                      <th scope="col">Buoy</th>
                      {depths.map(([depth]) => (
                        <th scope="col" className="num" key={depth}>
                          {depth} m
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {compared.map((buoy) => {
                      const href = buoyPath(buoy.id, { depth: 50 });
                      return (
                        <tr key={buoy.id} className="selectable" onClick={() => navigate(href)}>
                          <th scope="row">
                            <Link to={href} className="row-link" onClick={(e) => e.stopPropagation()}>
                              <span className="code">{buoy.id}</span>
                              <span className="buoy-name">{buoy.name}</span>
                            </Link>
                          </th>
                          {depths.map(([depth]) => {
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
