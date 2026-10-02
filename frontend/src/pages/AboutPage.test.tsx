import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keys } from "../api/queries";
import type { Buoy, Condition, DataCatalog, Method, OriginRules, SatelliteCondition } from "../api/types";
import * as production from "../fixtures/production";
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
    expect(screen.getByText(/for a heatwave at A01, the western side is just B01\. So its own onset never counts/)).toBeTruthy();
    expect(screen.getByText(/one at any of the four with no onset at the other three doesn't vote/)).toBeTruthy();
    expect(screen.getByText(/a buoy left on the other had data on at least 45 days of the window/)).toBeTruthy();
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

describe("AboutPage's buoys", () => {
  /** The paragraphs under the heading `id`, as text. */
  const section = (id: string) => {
    const texts = [];
    for (let at = document.getElementById(id)!.nextElementSibling; at && at.tagName !== "H2"; at = at.nextElementSibling) {
      if (at.tagName === "P") texts.push(at.textContent);
    }
    return texts;
  };

  beforeEach(() => serve({}));

  it("reads, on production's data, as it did when the buoys were written out", () => {
    renderAt("/", [
      [keys.buoys, production.buoys],
      [keys.method, production.method],
      [keys.originRules, production.rules],
    ]);

    expect(section("sources")).toEqual([
      "Temperature and salinity come from the University of Maine buoys A01, B01, E01, F01, I01, M01 and N01, at 1, " +
        "20 and 50 m and at M01 also 100–250 m, through the NERACOOS ERDDAP server, checked about every 10 minutes. " +
        "A reading is kept only if UMaine's quality flag marks it good and the QARTOD flag doesn't mark it suspect or " +
        "failed; in September 2026 the QARTOD flag marked no reading suspect, and failed only readings UMaine's flag " +
        "already marks. Readings are averaged by hour, then by day, and a day needs 18 hours with data, so the current " +
        "day counts from about 18:00 UTC on the hours so far. M01 has sent no data since September 2025 and N01 since " +
        "October 2021; their records are kept.",
    ]);
    expect(section("satellite")).toEqual([
      "The satellite record is NOAA's OISST v2.1, a daily sea surface temperature analysis on a quarter-degree grid, " +
        "from NOAA CoastWatch's ERDDAP server. Each buoy but N01 is compared with the nearest grid cell that has data, " +
        "at most 13 km away. Satellite heatwaves are found the same way as the buoys', against the cell's own " +
        "2003–2022 normal, and only days with data from both are compared.",
      "At 1 m, the buoys' daily temperatures follow the satellite's closely: pooled over the six, they correlate at " +
        "0.99, mostly through the seasons, and their anomalies from each series' own normal at 0.89 (as of October " +
        "2026). Even so, about a third of heatwave days at 1 m have no satellite heatwave. That share is the one to " +
        "hold the 20 and 50 m figures against, though each depth's share pools its own heatwave days from every buoy, " +
        "so they don't rest on the same days.",
    ]);
  });

  it("names the buoys, their depths, those that stopped and those without a satellite series as the API has them", () => {
    const at = (depth: number, state: Condition["state"], date: string) => ({ depth, state, date }) as Condition;
    const buoys: Buoy[] = [
      { ...buoy("A01", "Massachusetts Bay", 5), series: [1, 20, 50].map((d) => at(d, "offline", "2024-02-11")) },
      { ...buoy("B01", "Western Maine Shelf", 5), series: [1, 20, 50, 80].map((d) => at(d, "normal", "2026-10-01")), satellite: null },
      { ...buoy("F01", "West Penobscot Bay", 5), series: [1, 20, 50, 90, 120].map((d) => at(d, "heatwave", "2026-10-01")) },
    ];
    renderAt("/", [
      [keys.buoys, buoys],
      [keys.method, { ...production.method, depths: [1, 20] }],
    ]);

    const [sources] = section("sources");
    expect(sources).toContain(
      "from the University of Maine buoys A01, B01 and F01, at 1, 20 and 50 m and at B01 also 80 m and at F01 also " +
        "90–120 m, through",
    );
    expect(sources).toMatch(/ A01 has sent no data since February 2024; its record is kept\.$/);
    const [compared, pooled] = section("satellite");
    expect(compared).toContain("Each buoy but B01 is compared with the nearest grid cell");
    expect(pooled).toContain("pooled over the two, they correlate");
    expect(pooled).toContain("the one to hold the 20 m figures against");
  });

  it("claims nothing of the buoys before they load", () => {
    renderAt("/");

    const [sources] = section("sources");
    expect(sources).toMatch(/^Temperature and salinity come from the University of Maine buoys, through the NERACOOS/);
    expect(sources).not.toContain("no data since");
    const [compared, pooled] = section("satellite");
    expect(compared).toContain("The buoys are compared with the nearest grid cell that has data. ");
    expect(pooled).toContain("pooled over the buoys, they correlate");
    expect(pooled).toContain("the one to hold the deeper figures against");
  });
});
