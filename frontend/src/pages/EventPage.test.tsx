import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keys } from "../api/queries";
import type { Day, EventDetail, OriginRules } from "../api/types";
import { EventPage } from "./EventPage";

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
  margin: 2,
  offshore_buoys: ["N01", "M01"],
  western_buoys: ["A01", "B01"],
  deep_buoy: "M01",
  deep_depths: [100, 150, 200, 250],
};

const event: EventDetail = {
  buoy_id: "B01",
  depth: 50,
  start_date: "2021-06-10",
  end_date: "2021-06-20",
  peak_date: "2021-06-15",
  duration: 11,
  max_intensity: 2.4,
  mean_intensity: 1.6,
  category: 1,
  category_name: "Moderate",
  origin: "offshore",
  evidence: {
    salinity_anomaly: null,
    surface_heatwave_days: 0,
    stratification_before: 3,
    stratification_after: 2,
    deep_heatwave_days: 12,
    offshore_onset: "2021-05-30",
    western_onset: null,
    votes: { salinity: null, surface_heatwave: "offshore", stratification: null, deep: "offshore", onset_order: "offshore" },
  },
  signals: [],
  onsets: [],
};

const days: Day[] = ["2021-06-10", "2021-06-11"].map((date) => ({ date, value: 9, climatology: 8, threshold: 9.5, anomaly: 1 }));

/** Answers each variable's days at the heatwave's depth with `status`, or 200 and two days, and the heatwave itself with `eventStatus`. */
function serve(statuses: { temperature?: number; salinity?: number; event?: number }) {
  const fetch = vi.fn(async (url: string) => {
    const variable = url.includes("variable=salinity") ? "salinity" : url.includes("/daily") ? "temperature" : "event";
    const status = statuses[variable] ?? 200;
    const body = status !== 200 ? { detail: "Not found" } : variable === "event" ? event : days;
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetch);
}

/** The heatwave's page, with the heatwave loaded unless `fetchEvent`, and the buoys, heatwaves and rules loaded. */
function renderPage({ fetchEvent = false } = {}) {
  // Loaded data stays fresh, and a failure that's retried fails at once.
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retryDelay: 0 } } });
  if (!fetchEvent) client.setQueryData([...keys.event, "B01", 50, "2021-06-10"], event);
  client.setQueryData(keys.buoys, []);
  client.setQueryData(keys.events, []);
  client.setQueryData(keys.originRules, rules);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/events/B01/50/2021-06-10"]}>
        <Routes>
          <Route path="/events/:buoy/:depth/:start" element={<EventPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // jsdom has no layout: charts never get a width, so only their frames and notes render.
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

describe("EventPage", () => {
  it("says salinity has no normal in place of the temperature and salinity chart", async () => {
    serve({ salinity: 404 });
    renderPage();

    expect(await screen.findByText("No normal for salinity at 50 m, so it isn't charted.")).toBeTruthy();
    expect(screen.queryByText("Couldn't load the temperature and salinity.")).toBeNull();
  });

  it("still says it couldn't load them when salinity fails", async () => {
    serve({ salinity: 500 });
    renderPage();

    expect(await screen.findByText("Couldn't load the temperature and salinity.")).toBeTruthy();
    expect(screen.queryByText(/No normal for salinity/)).toBeNull();
  });

  it("says there's no such heatwave when the API has none", async () => {
    serve({ event: 404 });
    renderPage({ fetchEvent: true });

    expect(await screen.findByRole("heading", { name: "No such heatwave" })).toBeTruthy();
  });
});
