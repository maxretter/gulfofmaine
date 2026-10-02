import * as Plot from "@observablehq/plot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keys } from "../api/queries";
import type { Buoy, Condition, Day, Method } from "../api/types";
import * as production from "../fixtures/production";
import { DepthCharts, SeriesLegend } from "./DepthCharts";

// Counts the charts drawn.
vi.mock("@observablehq/plot", async (importOriginal) => {
  const actual = await importOriginal<typeof Plot>();
  return { ...actual, plot: vi.fn(actual.plot) };
});

const depth = (depth: number) => ({ depth }) as Condition;
const buoy: Buoy = { id: "B01", name: "Western Maine Shelf", latitude: 43.2, longitude: -70.4, series: [depth(1), depth(20), depth(50)], satellite: null };

const days: Day[] = ["2021-06-01", "2021-06-02", "2021-06-03"].map((date, i) => ({
  date,
  value: 12 + i,
  climatology: 11,
  threshold: 13,
  anomaly: 1 + i,
}));

/** Answers each depth's days with `status`, or 200 and three days. */
function serve(statuses: Record<number, number>) {
  const fetch = vi.fn(async (url: string) => {
    const depth = Number(url.split("/")[4]);
    const status = statuses[depth] ?? 200;
    return new Response(JSON.stringify(status === 200 ? days : { detail: "No climatology yet" }), { status });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderCharts() {
  // No wait between retries, so a failure that's retried fails as fast as one that isn't.
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <DepthCharts buoy={buoy} from="2021-06-01" to="2021-06-03" events={[]} />
    </QueryClientProvider>,
  );
  return client;
}

const panel = (depth: number) => screen.getByRole("heading", { name: new RegExp(`^${depth} m`) }).closest("section")!;
const lines = (depth: number) => panel(depth).querySelectorAll('[aria-label="line"] path').length;

beforeEach(() => {
  // jsdom has no layout: every chart is given the same width.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe() {
        this.callback([{ contentRect: { width: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DepthCharts", () => {
  it("draws the other depths when one has no normal, and says so in its place", async () => {
    const fetch = serve({ 20: 404 });
    renderCharts();

    expect(await screen.findByText("No normal for this depth, so it isn't charted.")).toBeTruthy();
    // The readout gives the newest day at the two depths with data, and says why 20 m has none.
    expect(await screen.findAllByText("14.0 °C", { exact: false })).toHaveLength(2);
    expect(screen.getByText("no normal")).toBeTruthy();
    expect(lines(1)).toBeGreaterThan(0);
    expect(lines(50)).toBeGreaterThan(0);
    expect(panel(20).querySelector("svg")).toBeNull();
    expect(screen.queryByText("Couldn't load the temperature series.")).toBeNull();
    // Asked once: asking again won't give it a normal.
    expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/buoys/B01/20/"))).toHaveLength(1);
  });

  it("moves the readout with the pointer without redrawing the charts", async () => {
    serve({});
    renderCharts();
    expect(await screen.findAllByText("14.0 °C", { exact: false })).toHaveLength(3);
    const drawn = vi.mocked(Plot.plot).mock.calls.length;

    // The plot area runs from x = 46 to 588 (600 wide, less the margins): Jun 1 at its left edge, Jun 2 halfway.
    const chart = panel(20).querySelector(".depth-chart")!;
    fireEvent.pointerMove(chart, { clientX: 47 });
    expect(await screen.findByText("Jun 1, 2021")).toBeTruthy();
    fireEvent.pointerMove(chart, { clientX: 317 });
    expect(await screen.findByText("Jun 2, 2021")).toBeTruthy();
    expect(screen.getAllByText("13.0 °C", { exact: false })).toHaveLength(3);
    expect(vi.mocked(Plot.plot).mock.calls.length).toBe(drawn);
  });

  it("redraws nothing when a refetch brings the same days, and only the depth whose days changed", async () => {
    const fetch = serve({});
    const client = renderCharts();
    expect(await screen.findAllByText("14.0 °C", { exact: false })).toHaveLength(3);
    const drawn = vi.mocked(Plot.plot).mock.calls.length;

    // As the live feed refetches them. TanStack Query tells the charts on its next tick.
    await act(() => client.invalidateQueries({ queryKey: keys.daily }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(vi.mocked(Plot.plot).mock.calls.length).toBe(drawn);

    fetch.mockImplementation(async (url: string) => {
      const warmer = url.startsWith("/api/buoys/B01/50/") ? days.map((d) => ({ ...d, value: d.value! + 1 })) : days;
      return new Response(JSON.stringify(warmer));
    });
    await act(() => client.invalidateQueries({ queryKey: keys.daily }));
    expect(await screen.findByText("15.0 °C", { exact: false })).toBeTruthy();
    expect(vi.mocked(Plot.plot).mock.calls.length).toBe(drawn + 1);
  });

  it("still says it couldn't load the series when a depth fails", async () => {
    serve({ 20: 500 });
    renderCharts();

    expect(await screen.findByText("Couldn't load the temperature series.")).toBeTruthy();
    expect(screen.queryByText("No normal for this depth, so it isn't charted.")).toBeNull();
  });
});

describe("SeriesLegend", () => {
  function renderLegend(method?: Method) {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    if (method) client.setQueryData(keys.method, method);
    render(
      <QueryClientProvider client={client}>
        <SeriesLegend buoy={production.buoys[0]} />
      </QueryClientProvider>,
    );
  }
  const keyTexts = () => Array.from(document.querySelectorAll(".series-legend .key"), (key) => key.textContent);

  it("names the threshold's percentile as the method has it, as it read when written out", () => {
    renderLegend(production.method);
    expect(keyTexts()).toEqual([
      "Daily mean",
      "Normal",
      "Heatwave threshold (90th percentile)",
      "Satellite, at the surface (top chart)",
    ]);

    cleanup();
    renderLegend({ ...production.method, percentile: 95 });
    expect(keyTexts()).toContain("Heatwave threshold (95th percentile)");
  });

  it("names no percentile before the method loads", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderLegend();
    expect(keyTexts()).toContain("Heatwave threshold");
  });
});
