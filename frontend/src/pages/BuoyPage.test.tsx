import * as Plot from "@observablehq/plot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keys } from "../api/queries";
import type { Agreement, Buoy, Condition, Day, HeatwaveEvent, Method, SatelliteCondition } from "../api/types";
import { BuoyPage } from "./BuoyPage";

// Counts the charts drawn.
vi.mock("@observablehq/plot", async (importOriginal) => {
  const actual = await importOriginal<typeof Plot>();
  return { ...actual, plot: vi.fn(actual.plot) };
});

const condition = (depth: number, temperature: number) =>
  ({ depth, state: "normal", first_date: "2021-06-01", date: "2021-06-03", temperature, anomaly: 1 }) as Condition;

/** B01 with its latest daily mean at both depths. */
const buoy = (temperature: number): Buoy => ({
  id: "B01",
  name: "Western Maine Shelf",
  latitude: 43.2,
  longitude: -70.4,
  series: [condition(1, temperature), condition(50, temperature)],
  satellite: null,
});

const heatwave = (depth: number) =>
  ({ buoy_id: "B01", depth, start_date: "2021-06-02", end_date: "2021-06-03", category: 1 }) as HeatwaveEvent;

const days: Day[] = ["2021-06-01", "2021-06-02", "2021-06-03"].map((date, i) => ({
  date,
  value: 12 + i,
  climatology: 11,
  threshold: 13,
  anomaly: 1 + i,
}));

// What the satellite misses at B01, for when it has a satellite series: the map's depths, and the comparison below 1 m.
const method = { depths: [1, 20, 50] } as Method;
const agreement = (depth: number): Agreement[] => [
  { buoy_id: "B01", depth, year: 2021, both: 10, buoy_only: 20, satellite_only: 5, neither: 300 },
];

function renderPage(buoys: Buoy[] = [buoy(14)]) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(keys.buoys, buoys);
  client.setQueryData(keys.events, [heatwave(1), heatwave(50)]);
  client.setQueryData(keys.method, method);
  for (const depth of [20, 50]) client.setQueryData([...keys.agreement, depth], agreement(depth));
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/buoys/B01"]}>
        <Routes>
          <Route path="/buoys/:buoy" element={<BuoyPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(days))));
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

describe("BuoyPage", () => {
  it("doesn't redraw the record or the charts when the buoys are refetched", async () => {
    const client = renderPage();
    // Both depths' tiles, then the readout at both once their days have loaded.
    await waitFor(() => expect(screen.getAllByText("14.0 °C", { exact: false })).toHaveLength(4));
    await waitFor(() => expect(document.querySelector(".range-brush .brush")).toBeTruthy());
    const drawn = vi.mocked(Plot.plot).mock.calls.length;

    // As the live feed does with a new reading: the page renders again with a new list of buoys.
    act(() => client.setQueryData(keys.buoys, [buoy(14.5)]));
    expect(await screen.findAllByText("14.5 °C")).toHaveLength(2);
    expect(vi.mocked(Plot.plot).mock.calls.length).toBe(drawn);
  });

  it("doesn't redraw what the satellite misses when the buoys are refetched", async () => {
    const withSatellite = (temperature: number) => ({ ...buoy(temperature), satellite: {} as SatelliteCondition });
    const client = renderPage([withSatellite(14)]);
    // Everything drawn: the readout at both depths once their days have loaded, the record, and both panels.
    await waitFor(() => expect(screen.getAllByText("14.0 °C", { exact: false })).toHaveLength(4));
    await waitFor(() => expect(document.querySelector(".range-brush .brush")).toBeTruthy());
    const card = screen.getByRole("heading", { name: "What the satellite misses here" }).closest("section")!;
    await waitFor(() => expect(card.querySelectorAll(".chart-panel svg")).toHaveLength(2));
    const drawn = vi.mocked(Plot.plot).mock.calls.length;

    // As the live feed does with a new reading: the page renders again with a new list of buoys.
    act(() => client.setQueryData(keys.buoys, [withSatellite(14.5)]));
    expect(await screen.findAllByText("14.5 °C")).toHaveLength(2);
    expect(vi.mocked(Plot.plot).mock.calls.length).toBe(drawn);
  });

  it("leaves out an offline depth's last values, and a reading since that its badge would contradict", () => {
    const offline: Condition = {
      ...condition(50, 9.9),
      state: "offline",
      date: "2021-05-20",
      anomaly: 2.3,
      reading_at: "2021-06-03T10:00:00Z",
      reading: 10.1,
    };
    const reporting = { ...condition(1, 14), reading_at: "2021-06-03T09:00:00Z", reading: 13.2 };
    renderPage([{ ...buoy(14), series: [reporting, offline] }]);
    const tiles = [...document.querySelectorAll(".latest .tile")].map((tile) => tile.textContent);

    expect(tiles[0]).toContain("14.0 °C+1.0 °C vs normal");
    expect(tiles[0]).toContain("Latest reading13.2 °C");
    expect(tiles[1]).toBe("50 m–– vs normalNo data since May 20, 2021");
  });
});
