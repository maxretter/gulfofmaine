import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keys } from "../api/queries";
import type { Day, EventDetail, HeatwaveEvent, OriginRules } from "../api/types";
import * as production from "../fixtures/production";
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
  status: "ended",
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

/**
 * The heatwave's page, with the heatwave (`detail`) loaded unless `fetchEvent`, and the buoys, heatwaves (`events`)
 * and rules (`originRules`) loaded.
 */
function renderPage({ fetchEvent = false, detail = event, events = [] as HeatwaveEvent[], originRules = rules } = {}) {
  // Loaded data stays fresh, and a failure that's retried fails at once.
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retryDelay: 0 } } });
  if (!fetchEvent) client.setQueryData([...keys.event, "B01", 50, "2021-06-10"], detail);
  client.setQueryData(keys.buoys, []);
  client.setQueryData(keys.events, events);
  client.setQueryData(keys.originRules, originRules);
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

  it("leaves the heatwave's own buoy, B01, off the onset order's sides", async () => {
    serve({});
    renderPage();

    expect(await screen.findByText("A01: western side")).toBeTruthy();
    expect(screen.getByText("N01, M01: eastern side")).toBeTruthy();
    expect(
      screen.getByText(
        "A heatwave began at N01 or M01 on May 30, 2021, and none at A01 in the 90 days before this one. " +
          "Onsets at B01, this heatwave's own buoy, don't count.",
      ),
    ).toBeTruthy();
  });

  it("gives a heatwave that has ended its length and ranks it among the buoy's others at its depth", () => {
    serve({});
    const longer = { ...event, start_date: "2019-07-01", end_date: "2019-07-30", duration: 30 };
    renderPage({ events: [longer, event] });

    expect(screen.getByText("11 days")).toBeTruthy();
    expect(screen.getByText("Jun 10, 2021 to Jun 20, 2021")).toBeTruthy();
    expect(screen.getByText("2nd longest of B01's 2 heatwaves at 50 m")).toBeTruthy();
  });

  it("says an ongoing or paused heatwave's length is so far, and ranks it as so far against those that ended", () => {
    serve({});
    const longer = { ...event, start_date: "2019-07-01", end_date: "2019-07-30", duration: 30 };
    for (const [status, dates] of [
      ["ongoing", "Jun 10, 2021 to Jun 20, 2021, and ongoing"],
      ["paused", "Jun 10, 2021 to Jun 20, 2021, then paused"],
    ] as const) {
      const unfinished = { ...event, status };
      renderPage({ detail: unfinished, events: [longer, unfinished] });

      expect(screen.getByText("11 days so far")).toBeTruthy();
      expect(screen.getByText(dates)).toBeTruthy();
      expect(screen.getByText("So far 2nd longest of B01's 2 heatwaves at 50 m")).toBeTruthy();
      expect(screen.getAllByText("So far the highest of B01's 2 heatwaves at 50 m")).toHaveLength(2);
      cleanup();
    }
  });

  it("names the deep water's buoy as the rules have it, as it read when written out on production's rules", async () => {
    /** The deep water's signal: its name and reading, and the signal table's columns for it. */
    const deep = () => {
      const signal = screen.getByText(/^Deep water at/).closest(".signal")!;
      const card = signal.closest(".card")!;
      const table = card.querySelector(":scope > details") as HTMLDetailsElement; // the signals' table, day by day
      table.open = true;
      fireEvent(table, new Event("toggle"));
      const columns = Array.from(table.querySelectorAll("th"), (th) => th.textContent).filter((th) => th!.includes("deep"));
      return [signal.querySelector("h3")!.textContent, signal.querySelector(".signal-reading")!.textContent, ...columns];
    };
    serve({});
    renderPage({ originRules: production.rules });
    await screen.findByText("Offshore or surface?");

    expect(deep()).toEqual([
      "Deep water at M01",
      "M01 at 100–250 m was in a heatwave on 12 days of the 30 before onset, which votes offshore.",
      "M01 deep vs normal",
      "M01 deep heatwave",
    ]);

    cleanup();
    renderPage({ originRules: { ...production.rules, deep_buoy: "I01", deep_depths: [80, 120] } });
    await screen.findByText("Offshore or surface?");

    expect(deep()).toEqual([
      "Deep water at I01",
      "I01 at 80–120 m was in a heatwave on 12 days of the 30 before onset, which votes offshore.",
      "I01 deep vs normal",
      "I01 deep heatwave",
    ]);
  });

  it("says there's no such heatwave when the API has none", async () => {
    serve({ event: 404 });
    renderPage({ fetchEvent: true });

    expect(await screen.findByRole("heading", { name: "No such heatwave" })).toBeTruthy();
  });
});
