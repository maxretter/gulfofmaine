import { useCallback } from "react";
import { useSearchParams } from "react-router";

import { isDay } from "../lib/dates";

export const DEPTHS = [1, 20, 50] as const;
export type Depth = (typeof DEPTHS)[number];

/**
 * The explorer's view lives in the URL, e.g. /?buoy=F01&depth=20&from=2021-05-01&to=2021-12-31,
 * so every view can be bookmarked and shared, and the back button works.
 */
export interface ExplorerState {
  buoy: string | null; // null: let the page choose
  depth: Depth;
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
    depth: (DEPTHS as readonly number[]).includes(depth) ? (depth as Depth) : DEPTHS[0],
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
