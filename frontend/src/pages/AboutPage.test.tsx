import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keys } from "../api/queries";
import type { Buoy, DataCatalog, Method, OriginRules, SatelliteCondition } from "../api/types";
import { AboutPage, MovedToAbout } from "./AboutPage";

/** The site's own method, as /api/method serves it. */
const siteMethod: Method = {
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

const rules: OriginRules = {
  depths: [20, 50],
  before: 30,
  after: 14,
  lookback: 90,
  min_days: 7,
  salty: 0.15,
  fresh: 0,
  drift: -1,
  mixed: 1,
  collapse: 0.5,
  together: 7,
  margin: 3,
  offshore_buoys: ["N01", "M01"],
  western_buoys: ["A01", "B01"],
  deep_buoy: "M01",
  deep_depths: [100, 150, 200, 250],
};

/** A buoy whose satellite cell is `distance_km` away. */
const buoy = (id: string, name: string, distance_km: number): Buoy => ({
  id,
  name,
  latitude: 43,
  longitude: -70,
  series: [],
  satellite: { distance_km } as SatelliteCondition,
});

const catalog: DataCatalog = {
  products: [
    {
      name: "A01_heatwaves_050m",
      buoy_id: "A01",
      depth: 50,
      files: [{ format: "csv", url: "/api/data/A01/50.csv", size: 2_074_354, modified: "2026-09-29T13:00:00Z" }],
    },
    {
      name: "gom_heatwaves_events",
      buoy_id: null,
      depth: null,
      files: [{ format: "nc", url: "/api/data/events.nc", size: 99_642, modified: "2026-09-29T13:00:00Z" }],
    },
  ],
  variables: [],
};

/** Answers each path with its body, or with an error if that's a status. */
function serve(responses: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = responses[url] ?? 404;
      return typeof body === "number" ? new Response("{}", { status: body }) : new Response(JSON.stringify(body));
    }),
  );
}

/** Where a page sent the browser. */
function Where() {
  const { pathname, hash } = useLocation();
  return <p>At {pathname + hash}</p>;
}

/** The page at `path`, with `cached` responses already loaded, by query key. */
function renderAt(path: string, cached: [readonly unknown[], unknown][] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const [key, data] of cached) client.setQueryData(key, data);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<AboutPage />} />
          <Route path="/methods" element={<MovedToAbout />} />
          <Route path="/data" element={<MovedToAbout section="data" />} />
          <Route path="/about" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AboutPage", () => {
  it("gives the rules, the satellite's reach and the files as the API has them", async () => {
    serve({
      "/api/buoys": [buoy("A01", "Massachusetts Bay", 7.5), buoy("N01", "Northeast Channel", 11.2)],
      "/api/origin/rules": rules,
      "/api/method": siteMethod,
      "/api/data": catalog,
    });
    renderAt("/");

    expect(screen.getByRole("heading", { level: 1, name: "Methods and data" })).toBeTruthy();
    expect(await screen.findByText(/Moderate \(1×\), Strong \(2×\), Severe \(3×\), Extreme \(4× or more\)/)).toBeTruthy();
    // The origin rules, from the API.
    expect(await screen.findByText("+0.15 or more")).toBeTruthy();
    expect(screen.getByText("M01 at 100–250 m")).toBeTruthy();
    expect(screen.getByText("N01 or M01 more than 7 days first, or only there")).toBeTruthy();
    expect(screen.getByText(/A label needs 3 more votes than the other side/)).toBeTruthy();
    // The farthest satellite cell, rounded up.
    expect(await screen.findByText(/with the nearest grid cell that has data, at most 12 km away/)).toBeTruthy();
    // Every file, under its buoy's name.
    expect(await screen.findByText("Every file (2)")).toBeTruthy();
    expect(screen.getByText("Massachusetts Bay")).toBeTruthy();
    expect(screen.getByRole("link", { name: "A01 50 m, CSV, 2.1 MB" }).getAttribute("href")).toBe("/api/data/A01/50.csv");
    expect(screen.getByRole("link", { name: "Events table, NetCDF, 100 KB" })).toBeTruthy();
  });

  it("still reads when nothing loads, and says the files didn't", async () => {
    serve({ "/api/buoys": 500, "/api/origin/rules": 500, "/api/method": 500, "/api/data": 500 });
    const client = renderAt("/");

    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(await screen.findByText("The list of files didn't load.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Origin labels" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("The origin rules didn't load.")).toBeTruthy();
    expect(screen.getByText("The method's parameters didn't load.")).toBeTruthy();
    expect(screen.queryByText(/at most \d+ km away/)).toBeNull();
    expect(screen.queryByText(/^Every file/)).toBeNull();
  });

  it("lists no files before the sync has written any", () => {
    serve({});
    renderAt("/", [
      [keys.buoys, []],
      [keys.originRules, rules],
      [keys.method, siteMethod],
      [["data"], { products: [], variables: [] }], // useDataCatalog's
    ]);

    expect(screen.getByText("+0.15 or more")).toBeTruthy();
    expect(screen.queryByText(/^Every file/)).toBeNull();
    expect(screen.queryByText("The list of files didn't load.")).toBeNull();
  });

  it.each([
    ["/methods", "/about"],
    ["/methods#origin", "/about#origin"],
    ["/data", "/about#data"],
    ["/data#sources", "/about#sources"],
  ])("sends %s, from before the pages were merged, to %s", (from, to) => {
    serve({});
    renderAt(from);

    expect(screen.getByText(`At ${to}`)).toBeTruthy();
  });
});

describe("AboutPage's method", () => {
  /** Not the site's numbers, so that any the page didn't take from the API would show. */
  const method: Method = {
    baseline_start: 1991,
    baseline_end: 2020,
    percentile: 95,
    window_half_width: 5,
    smooth_width: 31,
    min_duration: 7,
    max_gap: 3,
    max_pad: 4,
    categories: ["Moderate", "Strong"],
    min_hours: 20,
    offline_after: 3,
    depths: [1, 20, 50],
  };

  function renderPage(withMethod: boolean) {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    client.setQueryData(keys.buoys, []);
    if (withMethod) client.setQueryData(keys.method, method);
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AboutPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
  });

  it("states the method with the API's numbers", () => {
    renderPage(true);
    const text = document.querySelector("article")!.textContent;

    expect(text).toContain(
      "A marine heatwave is at least seven days in a row above the 95th percentile for the time of year, with spells " +
        "three days apart or less joined into one",
    );
    expect(text).toContain("Up to four missing days in a row are filled in");
    expect(text).toContain("each side of it must last seven days to count");
    expect(text).toContain("The normal and the 95th percentile are computed as in that paper");
    expect(text).toContain("from the years 1991–2020 that it has data for");
    expect(text).toContain("the gap between the normal and the threshold: Moderate (1×), Strong (2× or more).");
    expect(text).toContain("these records allow 30.");
    expect(text).toContain("set to fill gaps of up to four days as here");
    expect(text).toContain("a day needs 20 hours with data, so the current day counts from about 20:00 UTC");
    expect(text).toContain("against the cell's own 1991–2020 normal");
  });

  it("says so if the method didn't load, and states none of it", async () => {
    renderPage(false);

    expect(await screen.findByText("The method's parameters didn't load.")).toBeTruthy();
    const text = document.querySelector("article")!.textContent;
    expect(text).not.toContain("percentile");
    expect(text).not.toContain("hours with data");
    expect(text).toContain("against the cell's own normal");
  });
});
