import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keys } from "../api/queries";
import type { Agreement, Buoy } from "../api/types";
import { SatellitePage } from "./SatellitePage";

const row = (buoy_id: string, depth: number, both: number, buoy_only: number): Agreement => ({
  buoy_id,
  depth,
  year: 2021,
  both,
  buoy_only,
  satellite_only: 5,
  neither: 300,
});

const buoy = (id: string, name: string): Buoy => ({ id, name, latitude: 43, longitude: -70, series: [], satellite: null });

function renderPage(agreement: Record<number, Agreement[]>) {
  const client = new QueryClient();
  client.setQueryData(keys.buoys, [buoy("A01", "Massachusetts Bay"), buoy("B01", "Western Maine Shelf"), buoy("N01", "Northeast Channel")]);
  for (const [depth, rows] of Object.entries(agreement)) client.setQueryData([...keys.agreement, Number(depth)], rows);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SatellitePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
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

  it("says so when the satellite record hasn't been loaded", () => {
    renderPage({ 1: [], 20: [], 50: [] });
    expect(screen.getByText(/the satellite record hasn't been loaded/)).toBeTruthy();
    expect(screen.queryByText(/^At \d+ m$/)).toBeNull();
  });
});
