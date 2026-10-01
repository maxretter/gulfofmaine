import { useCallback } from "react";
import { useSearchParams } from "react-router";

import type { HeatwaveEvent } from "../api/types";
import { isDay } from "../lib/dates";
import { eventRange } from "../lib/events";

/** The depth a view shows when its URL names none, in meters: every buoy has 1 m. The map's come from useMethod. */
export const DEFAULT_DEPTH = 1;
const DEEPEST = 1000; // meters: anything below is a mistyped URL
const BUOY_ID = /^[A-Z0-9]{2,8}$/;

/**
 * The view lives in the URL: the map's depth on the front page (/?depth=20), and on a buoy's page the depth of
 * its record strip and the period shown (/buoys/F01?depth=20&from=2021-05-01&to=2021-12-31). So every view can be
 * bookmarked and shared, and the back button works.
 */
export interface BuoyView {
  depth: number; // meters
  from: string | null; // null: the default range
  to: string | null;
}

export function parseViewParams(params: URLSearchParams): BuoyView {
  const depth = Number(params.get("depth"));
  let from = params.get("from");
  let to = params.get("to");
  if (!isDay(from) || !isDay(to)) {
    from = to = null;
  } else if (from > to) {
    [from, to] = [to, from];
  }
  return {
    depth: Number.isInteger(depth) && depth > 0 && depth <= DEEPEST ? depth : DEFAULT_DEPTH,
    from,
    to,
  };
}

export function toViewParams(view: BuoyView): URLSearchParams {
  const params = new URLSearchParams();
  if (view.depth !== DEFAULT_DEPTH) params.set("depth", String(view.depth));
  if (view.from && view.to) {
    params.set("from", view.from);
    params.set("to", view.to);
  }
  return params;
}

function withQuery(path: string, params: URLSearchParams): string {
  return params.size ? `${path}?${params}` : path;
}

/** A buoy's page, optionally at a depth and period. */
export function buoyPath(buoy: string, view: Partial<BuoyView> = {}): string {
  return withQuery(`/buoys/${buoy}`, toViewParams({ depth: DEFAULT_DEPTH, from: null, to: null, ...view }));
}

/** A buoy's page zoomed to one of its heatwaves, at its depth. */
export function heatwavePeriodPath(event: HeatwaveEvent): string {
  return buoyPath(event.buoy_id, { depth: event.depth, ...eventRange(event) });
}

/** Where a link into the old single-page explorer (/?buoy=F01&depth=20&from=…) now goes; null for any other. */
export function legacyExplorerPath(params: URLSearchParams): string | null {
  const buoy = params.get("buoy")?.toUpperCase();
  if (!buoy || !BUOY_ID.test(buoy)) return null;
  return buoyPath(buoy, parseViewParams(params));
}

/**
 * Read and update the view. Pass `{ replace: true }` for continuous
 * changes such as brushing, so they don't flood the browser history.
 */
export function useBuoyView() {
  const [params, setParams] = useSearchParams();
  const view = parseViewParams(params);
  const update = useCallback(
    (patch: Partial<BuoyView>, options?: { replace?: boolean }) =>
      // Changing the view shouldn't scroll the page back to the top.
      setParams((current) => toViewParams({ ...parseViewParams(current), ...patch }), {
        ...options,
        preventScrollReset: true,
      }),
    [setParams],
  );
  return [view, update] as const;
}
