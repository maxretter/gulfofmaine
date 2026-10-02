import * as Plot from "@observablehq/plot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withReading } from "../api/live";
import { keys } from "../api/queries";
import type { Agreement, Buoy, Condition, Method, ReadingMessage, SatelliteCondition } from "../api/types";
import * as production from "../fixtures/production";
import { SatellitePage } from "./SatellitePage";

// Counts the charts drawn.
vi.mock("@observablehq/plot", async (importOriginal) => {
  const actual = await importOriginal<typeof Plot>();
  return { ...actual, plot: vi.fn(actual.plot) };
});

const row = (buoy_id: string, depth: number, both: number, buoy_only: number): Agreement => ({
  buoy_id,
  depth,
  year: 2021,
  both,
  buoy_only,
  satellite_only: 5,
  neither: 300,
});

/** As /api/method sends it. */
const method: Method = {
  baseline_start: 2003,
  baseline_end: 2022,
  percentile: 90,
  window_half_width: 5,
  smooth_width: 31,
  min_duration: 5,
  max_gap: 2,
  max_pad: 2,
  categories: ["Moderate", "Strong", "Severe", "Extreme"],
  min_hours: 18,
  offline_after: 3,
  depths: [1, 20, 50],
};

const buoy = (id: string, name: string): Buoy => ({ id, name, latitude: 43, longitude: -70, series: [], satellite: null });

/** The page with these comparisons and buoys loaded; with `buoys` null, the buoys aren't. */
function renderPage(
  agreement: Record<number, Agreement[]>,
  buoys: Buoy[] | null = [buoy("A01", "Massachusetts Bay"), buoy("B01", "Western Maine Shelf"), buoy("N01", "Northeast Channel")],
) {
  const client = new QueryClient();
  client.setQueryData(keys.method, method);
  if (buoys) client.setQueryData(keys.buoys, buoys);
  for (const [depth, rows] of Object.entries(agreement)) client.setQueryData([...keys.agreement, Number(depth)], rows);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SatellitePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  // jsdom has no layout: charts never get a width, so only their frames and tables render.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SatellitePage", () => {
  it("gives the share missed at each depth, deepest first, and per buoy", () => {
    renderPage({
      1: [row("A01", 1, 30, 10), row("B01", 1, 20, 20)],
      20: [row("A01", 20, 10, 10), row("B01", 20, 0, 0)],
      50: [row("A01", 50, 10, 30), row("B01", 50, 5, 55)],
    });

    const figures = screen.getAllByText(/^At \d+ m$/).map((label) => label.textContent);
    expect(figures).toEqual(["At 50 m", "At 20 m", "At 1 m"]);
    expect(screen.getByText(/The buoys' shallowest depth/).textContent).toMatch(/^of 80 heatwave days/);
    expect(screen.getByRole("heading", { name: "Heatwave days at 20 and 50 m, every buoy together" })).toBeTruthy();
    // 50 m: 85 of 100 days missed; 1 m: 30 of 80.
    expect(screen.getByText("85%")).toBeTruthy();
    expect(screen.getByText(/of 100 heatwave days/)).toBeTruthy();
    expect(screen.getByText("38%")).toBeTruthy();

    const b01 = screen.getByRole("link", { name: /B01/ });
    expect(b01.getAttribute("href")).toBe("/buoys/B01?depth=50");
    const cells = within(b01.closest("tr")!).getAllByRole("cell");
    expect(cells.map((cell) => cell.textContent)).toEqual(["50%of 40 days", "–", "92%of 60 days"]);
    // A buoy without a satellite comparison isn't listed.
    expect(screen.queryByRole("link", { name: /N01/ })).toBeNull();
  });

  it("leaves out a buoy without a satellite series where it says what each is set beside, on production's data", () => {
    const client = new QueryClient();
    client.setQueryData(keys.method, production.method);
    client.setQueryData(keys.buoys, production.buoys);
    for (const [depth, rows] of Object.entries(production.agreements)) client.setQueryData([...keys.agreement, Number(depth)], rows);
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SatellitePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(document.querySelector(".lead")!.textContent).toBe(
      "Each buoy but N01 is set beside NOAA's satellite record of sea surface temperature in the nearest grid cell. On " +
        "the days a buoy logged a heatwave, did the satellite show one at the surface? How the comparison is made.",
    );
    const tiles = Array.from(document.querySelectorAll(".tile"), (tile) => tile.textContent);
    expect(tiles).toEqual([
      "At 50 m68%of 3,714 heatwave days had no heatwave at the surface above.",
      "At 20 m64%of 3,411 heatwave days had no heatwave at the surface above.",
      "At 1 m35%of 2,952 heatwave days had no heatwave at the surface above. The buoys' shallowest depth, to compare " +
        "the others with.",
    ]);
  });

  it("says each buoy is set beside the satellite when every one has a series, and claims neither before they load", () => {
    const lead = () => document.querySelector(".lead")!.textContent;
    const satellite = { distance_km: 5 } as SatelliteCondition;
    renderPage({ 1: [], 20: [], 50: [] }, [{ ...buoy("A01", "Massachusetts Bay"), satellite }]);
    expect(lead()).toMatch(/^Each buoy is set beside NOAA's satellite record/);

    cleanup();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))); // the buoys never arrive
    renderPage({ 1: [], 20: [], 50: [] }, null);
    expect(lead()).toMatch(/^The buoys are set beside NOAA's satellite record/);
  });

  it("redraws no panel when a reading comes in, or the comparison is refetched unchanged", async () => {
    // Every chart is 600 px wide, so each is drawn.
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
    const agreement = {
      1: [row("A01", 1, 30, 10)],
      20: [row("A01", 20, 10, 10)],
      50: [row("A01", 50, 10, 30)],
    };
    const a01 = { ...buoy("A01", "Massachusetts Bay"), series: [{ depth: 20, reading: 9, reading_at: null } as Condition] };
    // As the API answers a refetch: the same buoys and comparison.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const depth = new URL(url, "http://localhost").searchParams.get("depth");
        return new Response(JSON.stringify(depth === null ? [a01] : agreement[Number(depth) as 1 | 20 | 50]));
      }),
    );
    const client = renderPage(agreement, [a01]);
    await waitFor(() => expect(document.querySelectorAll(".chart-panel svg")).toHaveLength(2));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    const drawn = vi.mocked(Plot.plot).mock.calls.length;

    // As the live feed writes in a reading, then refetches the buoys; and as a status message has it refetch the
    // comparison, which comes back the same. TanStack Query tells the page on its next tick.
    const reading: ReadingMessage = { type: "reading", buoy: "A01", depth: 20, time: "2021-06-11T01:00:00Z", temperature: 9.5 };
    act(() => client.setQueryData<Buoy[]>(keys.buoys, (buoys) => buoys && withReading(buoys, reading)));
    await act(() => client.invalidateQueries({ queryKey: keys.buoys }));
    await act(() => client.invalidateQueries({ queryKey: keys.agreement }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));

    expect(vi.mocked(Plot.plot).mock.calls.length).toBe(drawn);
  });

  it("says so when the satellite record hasn't been loaded", () => {
    renderPage({ 1: [], 20: [], 50: [] });
    expect(screen.getByText(/the satellite record hasn't been loaded/)).toBeTruthy();
    expect(screen.queryByText(/^At \d+ m$/)).toBeNull();
  });
});
