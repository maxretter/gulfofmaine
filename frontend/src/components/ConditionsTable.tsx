import type { Buoy } from "../api/types";
import { formatSigned, formatTemp } from "../lib/format";
import { StateBadge } from "./StateBadge";

interface Props {
  buoys: Buoy[];
  depth: number;
  selected: string;
  onSelect: (buoy: string) => void;
}

export function ConditionsTable({ buoys, depth, selected, onSelect }: Props) {
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
          const isSelected = buoy.id === selected;
          return (
            // The row is the click target; the button makes it reachable by keyboard.
            <tr
              key={buoy.id}
              className={["selectable", isSelected && "selected", offline && "offline"].filter(Boolean).join(" ")}
              onClick={() => onSelect(buoy.id)}
            >
              <th scope="row">
                <button type="button" className="row-button" aria-pressed={isSelected}>
                  <span className="code">{buoy.id}</span>
                  <span className="buoy-name">{buoy.name}</span>
                </button>
              </th>
              <td className="num">{formatTemp(condition.temperature)}</td>
              <td className="num">{formatSigned(condition.anomaly)}</td>
              <td>
                <StateBadge condition={condition} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
