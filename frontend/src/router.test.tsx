import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Buoy } from "./api/types";
import { routes } from "./router";

vi.mock("./pages/SatellitePage", () => ({
  SatellitePage: () => {
    throw new Error("Couldn't draw the page");
  },
}));

/** A buoy the sync hasn't placed yet, as on a fresh database. */
const unplaced: Buoy = {
  id: "B01",
  name: "Western Maine Shelf",
  latitude: null,
  longitude: null,
  series: [
    {
      depth: 1,
      dataset_id: "B01_ocean_001m",
      erddap_url: "",
      state: "no_data",
      first_date: null,
      date: null,
      temperature: null,
      climatology: null,
      anomaly: null,
      threshold: null,
      days_above: 0,
      category: null,
      category_name: null,
      event_start: null,
      synced_at: null,
      reading_at: null,
      reading: null,
    },
  ],
  satellite: null,
};

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/buoys" ? [unplaced] : []))),
  );
  vi.stubGlobal("scrollTo", () => {}); // jsdom has no scrolling
  // The live feed never connects.
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("router", () => {
  it("shows the map before any buoy has a position", async () => {
    renderAt("/");

    expect(await screen.findByText("Western Maine Shelf")).toBeTruthy();
    expect(document.querySelector(".map.leaflet-container")).toBeTruthy();
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });

  it("says so under the site's header when a page fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // React reports the error too
    renderAt("/satellite");

    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(screen.getByRole("link", { name: "see every buoy now" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("navigation", { name: "Site" })).toBeTruthy();
  });
});
