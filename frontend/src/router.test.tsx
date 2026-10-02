import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Buoy, Method } from "./api/types";
import { routes } from "./router";

vi.mock("./pages/SatellitePage", () => ({
  SatellitePage: () => {
    throw new Error("Couldn't draw the page");
  },
}));

// The Origins page's code arrives when the test lets it, as over a slow connection.
const arrival = vi.hoisted(() => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve: () => resolve() };
});
vi.mock("./pages/OriginsPage", async () => {
  await arrival.promise;
  return { OriginsPage: () => <h1>Origins page</h1> };
});

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
    vi.fn(
      async (url: string) =>
        new Response(JSON.stringify(url === "/api/buoys" ? [unplaced] : url === "/api/method" ? method : [])),
    ),
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
    // The page loads when first visited: until then, the header, with a note under it.
    expect(screen.getByRole("navigation", { name: "Site" })).toBeTruthy();
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("Live from the buoys")).toBeNull();

    expect(await screen.findByText("Western Maine Shelf")).toBeTruthy();
    expect(document.querySelector(".map.leaflet-container")).toBeTruthy();
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });

  it("dims the page it leaves while the next one's code is on its way", async () => {
    renderAt("/nowhere");
    const main = screen.getByRole("main");
    expect(await screen.findByText("Page not found")).toBeTruthy();
    expect(main.getAttribute("aria-busy")).toBe("false");

    fireEvent.click(screen.getByRole("link", { name: "Origins" }));
    // The page it leaves stays up, dimmed, under the link taken.
    await vi.waitFor(() => expect(main.getAttribute("aria-busy")).toBe("true"));
    expect(screen.getByText("Page not found")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Origins" }).className).toBe("pending");

    await act(async () => arrival.resolve());
    expect(await screen.findByText("Origins page")).toBeTruthy();
    expect(main.getAttribute("aria-busy")).toBe("false");
    expect(screen.getByRole("link", { name: "Origins" }).className).toBe("active");
  });

  it("says so under the site's header when a page fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // React reports the error too
    renderAt("/satellite");

    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(screen.getByRole("link", { name: "see every buoy now" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("navigation", { name: "Site" })).toBeTruthy();
  });
});
