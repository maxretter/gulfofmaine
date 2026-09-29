import { useEffect } from "react";
import { Link } from "react-router";

import { alertId } from "../api/live";
import { useBuoys } from "../api/queries";
import type { StatusMessage } from "../api/types";
import { categories } from "../lib/colors";
import { Swatch } from "./StateBadge";

const SHOWN_MS = 20_000;

interface Props {
  alerts: StatusMessage[]; // buoy depths that just entered a heatwave, oldest first
  onDismiss: (id: string) => void; // stable across renders
}

/** Announces each buoy depth entering a heatwave, from the live feed; each note goes after 20 seconds. */
export function HeatwaveToasts({ alerts, onDismiss }: Props) {
  return (
    <div className="toasts" aria-live="polite">
      {alerts.map((alert) => (
        <Toast key={alertId(alert)} alert={alert} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function Toast({ alert, onDismiss }: { alert: StatusMessage; onDismiss: (id: string) => void }) {
  const buoys = useBuoys();
  const id = alertId(alert);
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(id), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [id, onDismiss]);

  const category = categories[alert.category ?? 1];
  const name = buoys.data?.find((buoy) => buoy.id === alert.buoy)?.name;
  return (
    <div className="toast">
      <Swatch color={category.color} />
      <p>
        <span className="code">{alert.buoy}</span> {name} entered a {category.name.toLowerCase()} heatwave at{" "}
        {alert.depth} m.{" "}
        <Link to={`/?buoy=${alert.buoy}&depth=${alert.depth}#detail`} onClick={() => onDismiss(id)}>
          See it
        </Link>
      </p>
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => onDismiss(id)}>
        ×
      </button>
    </div>
  );
}
