import { useLive } from "../api/live";
import { useBuoys } from "../api/queries";
import { colors } from "../lib/colors";
import { latest } from "../lib/dates";
import { formatTime } from "../lib/format";
import { Swatch } from "./StateBadge";

const LABELS = { live: "Live", connecting: "Connecting…", reconnecting: "Reconnecting…" };

/** Whether the live feed is connected, and the time of the newest reading on the site. */
export function LiveIndicator() {
  const { status } = useLive();
  const buoys = useBuoys();
  const newest = latest(buoys.data?.flatMap((buoy) => buoy.series.map((s) => s.reading_at)) ?? []);
  const live = status === "live";
  return (
    <span className={`state live-indicator${live ? "" : " muted"}`}>
      <Swatch color={live ? colors.observed : colors.axis} variant={live ? "dot" : "hollow"} />
      {LABELS[status]}
      {live && newest && <span className="live-time">· last reading {formatTime(newest)}</span>}
    </span>
  );
}
