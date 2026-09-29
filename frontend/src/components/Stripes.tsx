import { useMemo, useState } from "react";

import { useStripes } from "../api/queries";
import { anomalyColor } from "../lib/colors";
import { formatMonth, formatSigned } from "../lib/format";
import { type Stripe, stripes, STRIPES_DEPTH, warmest } from "../lib/stripes";

function useMonths(): Stripe[] {
  const rows = useStripes(STRIPES_DEPTH);
  return useMemo(() => stripes(rows.data ?? []), [rows.data]);
}

/** The months as stripes, stretched to fill their box. Each overlaps the next a little, so no seams show. */
function StripesSvg({ months }: { months: Stripe[] }) {
  return (
    <svg viewBox={`0 0 ${months.length} 1`} preserveAspectRatio="none" aria-hidden="true">
      {months.map(
        (m, i) => m.anomaly !== null && <rect key={m.month} x={i} width={1.1} height={1} fill={anomalyColor(m.anomaly)!} />,
      )}
    </svg>
  );
}

/** Across the top of every page: the Gulf's record at depth as the site's own mark. */
export function StripesBand() {
  const months = useMonths();
  return <div className="stripes-band">{months.length > 0 && <StripesSvg months={months} />}</div>;
}

/** The stripes as a figure, with its years, a key, and the month under the pointer. */
export function StripesFigure() {
  const months = useMonths();
  const [hovered, setHovered] = useState<number | null>(null);
  const top = useMemo(() => warmest(months), [months]);
  if (!months.length) return <div className="stripes-figure stripes-frame" />;

  const at = (month: string) => (100 * months.findIndex((m) => m.month === month)) / months.length;
  const years = months.filter((m) => m.month.endsWith("-01") && Number(m.month.slice(0, 4)) % 5 === 0);
  const shown = hovered === null ? null : months[hovered];
  const first = formatMonth(months[0].month);
  const last = formatMonth(months[months.length - 1].month);

  return (
    <figure className="stripes-figure">
      <div
        className="stripes-frame"
        role="img"
        aria-label={`The Gulf of Maine at ${STRIPES_DEPTH} m against normal, month by month from ${first} to ${last}${
          top ? `. Warmest: ${formatMonth(top.month)}, ${formatSigned(top.anomaly)}` : ""
        }.`}
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const i = Math.floor(((e.clientX - box.left) / box.width) * months.length);
          setHovered(Math.max(0, Math.min(months.length - 1, i)));
        }}
        onPointerLeave={() => setHovered(null)}
      >
        <StripesSvg months={months} />
        {hovered !== null && (
          <div className="stripes-marker" style={{ left: `${(100 * (hovered + 0.5)) / months.length}%` }} />
        )}
      </div>
      <div className="stripes-years" aria-hidden="true">
        {years.map((m) => (
          <span key={m.month} style={{ left: `${at(m.month)}%` }}>
            {m.month.slice(0, 4)}
          </span>
        ))}
      </div>
      <figcaption>
        <span className="stripes-readout" aria-live="off">
          {shown
            ? `${formatMonth(shown.month)}: ${shown.anomaly === null ? "no data" : `${formatSigned(shown.anomaly)} against normal`}`
            : top && `Warmest month: ${formatMonth(top.month)}, ${formatSigned(top.anomaly)}`}
        </span>
        <span>
          The Gulf at {STRIPES_DEPTH} m since {first}, a month to a stripe: how far the buoys' water was from its
          2003–2022 normal, <span className="cool">cooler</span> or <span className="warm">warmer</span>, on average.
        </span>
      </figcaption>
    </figure>
  );
}
