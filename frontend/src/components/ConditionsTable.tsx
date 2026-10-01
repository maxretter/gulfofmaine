import { Link, useNavigate } from "react-router";

import type { Buoy } from "../api/types";
import { formatSigned, formatTemp } from "../lib/format";
import { StateBadge } from "./StateBadge";

interface Props {
  buoys: Buoy[];
  depth: number;
  pathFor: (buoy: string) => string; // each row leads to its buoy's page
}

export function ConditionsTable({ buoys, depth, pathFor }: Props) {
  const navigate = useNavigate();
  return (
    <table className="conditions">
      <thead>
        <tr>
          <th scope="col">Buoy</th>
          <th scope="col" className="num">
            Temp.
          </th>
          <th scope="col" className="num">
            vs normal
          </th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {buoys.map((buoy) => {
          const condition = buoy.series.find((s) => s.depth === depth);
          if (!condition) return null;
          const offline = condition.state === "offline" || condition.state === "no_data";
          const href = pathFor(buoy.id);
          return (
            // The whole row is the click target; the link makes it reachable by keyboard.
            <tr
              key={buoy.id}
              className={["selectable", offline && "offline"].filter(Boolean).join(" ")}
              onClick={() => navigate(href)}
            >
              <th scope="row">
                <Link to={href} className="row-link" onClick={(e) => e.stopPropagation()}>
                  <span className="code">{buoy.id}</span>
                  <span className="buoy-name">{buoy.name}</span>
                </Link>
              </th>
              {/* An offline buoy's last values are months or years old: left out, so they can't pass for today's. */}
              <td className="num">{formatTemp(offline ? null : condition.temperature)}</td>
              <td className="num">{formatSigned(offline ? null : condition.anomaly)}</td>
              <td>
                <StateBadge condition={condition} depth={depth} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
