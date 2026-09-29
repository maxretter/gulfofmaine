import { useCallback } from "react";
import { useSearchParams } from "react-router";

import type { HeatwaveEvent } from "../api/types";
import { isDay } from "../lib/dates";
import { eventRange } from "../lib/events";

/** The depths the map can show. Each buoy's own depths come from the API and can include others. */
export const DEPTHS = [1, 20, 50] as const;
const DEEPEST = 1000; // metres: anything below is a mistyped URL

/**
 * The explorer's view lives in the URL, e.g. /?buoy=F01&depth=20&from=2021-05-01&to=2021-12-31,
 * so every view can be bookmarked and shared, and the back button works.
 */
export interface ExplorerState {
  buoy: string | null; // null: let the page choose
  depth: number; // metres
  from: string | null; // null: the default range
  to: string | null;
}

export function parseExplorerParams(params: URLSearchParams): ExplorerState {
  const depth = Number(params.get("depth"));
  const buoy = params.get("buoy")?.toUpperCase() ?? null;
  let from = params.get("from");
  let to = params.get("to");
  if (!isDay(from) || !isDay(to)) {
    from = to = null;
  } else if (from > to) {
    [from, to] = [to, from];
  }
  return {
    buoy: buoy && /^[A-Z0-9]{2,8}$/.test(buoy) ? buoy : null,
    depth: Number.isInteger(depth) && depth > 0 && depth <= DEEPEST ? depth : DEPTHS[0],
    from,
    to,
  };
}

export function toSearchParams(state: ExplorerState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.buoy) params.set("buoy", state.buoy);
  if (state.depth !== DEPTHS[0]) params.set("depth", String(state.depth));
  if (state.from && state.to) {
    params.set("from", state.from);
    params.set("to", state.to);
  }
  return params;
}

/** The explorer zoomed to a heatwave, at its buoy and depth. */
export function explorerPath(event: HeatwaveEvent): string {
  const params = toSearchParams({ buoy: event.buoy_id, depth: event.depth, ...eventRange(event) });
  return `/?${params}#detail`;
}

/**
 * Read and update the explorer state. Pass `{ replace: true }` for continuous
 * changes such as brushing, so they don't flood the browser history.
 */
export function useExplorerState() {
  const [params, setParams] = useSearchParams();
  const state = parseExplorerParams(params);
  const update = useCallback(
    (patch: Partial<ExplorerState>, options?: { replace?: boolean }) =>
      // Changing the view shouldn't scroll the page back to the top.
      setParams((current) => toSearchParams({ ...parseExplorerParams(current), ...patch }), {
        ...options,
        preventScrollReset: true,
      }),
    [setParams],
  );
  return [state, update] as const;
}
