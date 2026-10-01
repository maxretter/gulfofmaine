import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Buoy, Condition, HeatwaveEvent } from "../api/types";
import { BuoysPage } from "./BuoysPage";

function condition(depth: number, state: Condition["state"], first_date: string, date: string): Condition {
  return {
    depth,
    dataset_id: "",
    erddap_url: "",
    state,
    first_date,
    date,
    temperature: 12,
    climatology: 11,
    anomaly: 1,
    threshold: 12.5,
    days_above: state === "heatwave" ? 9 : 0,
    category: state === "heatwave" ? 2 : null,
    category_name: null,
    event_start: null,
    synced_at: "2026-09-29T01:20:00Z",
    reading_at: null,
    reading: null,
  };
}

const buoys: Buoy[] = [
  {
    id: "B01",
    name: "Western Maine Shelf",
    latitude: 43.2,
    longitude: -70.4,
    series: [condition(1, "heatwave", "2001-07-10", "2026-09-28"), condition(50, "normal", "2001-07-12", "2026-09-27")],
    satellite: null,
  },
  {
    id: "N01",
    name: "Northeast Channel",
    latitude: 42.3,
    longitude: -65.9,
    series: [condition(1, "offline", "2004-06-08", "2021-10-08"), condition(180, "offline", "2004-06-09", "2021-10-07")],
    satellite: null,
  },
];

const heatwave = (start_date: string) => ({ buoy_id: "B01", depth: 1, start_date }) as HeatwaveEvent;

/** Answers each path with its body, or with an error if that's a status; a path not listed never answers. */
function serve(responses: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (!(url in responses)) return new Promise<Response>(() => {});
      const body = responses[url];
      return Promise.resolve(
        typeof body === "number" ? new Response("{}", { status: body }) : new Response(JSON.stringify(body)),
      );
    }),
  );
}

/** Where a link or a click led. */
function Where() {
  const { pathname, search } = useLocation();
  return <p>At {pathname + search}</p>;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/buoys"]}>
        <Routes>
          <Route path="/buoys" element={<BuoysPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const row = (name: RegExp) => screen.getByRole("link", { name }).closest("tr")!;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BuoysPage", () => {
  it("lists every buoy with its depths, record, heatwaves and state now, each leading to its page", async () => {
    serve({ "/api/buoys": buoys, "/api/events": [heatwave("2012-07-01"), heatwave("2021-08-01")] });
    renderPage();

    const b01 = await screen.findByRole("link", { name: /B01/ });
    expect(b01.getAttribute("href")).toBe("/buoys/B01");
    expect(within(row(/B01/)).getByText("1 and 50 m")).toBeTruthy();
    expect(within(row(/B01/)).getByText("Jul 10, 2001 – Sep 28, 2026")).toBeTruthy();
    expect(within(row(/B01/)).getByText("In a heatwave at 1 m")).toBeTruthy();
    // Its heatwaves, counted once they load, lead to the list of them.
    expect((await within(row(/B01/)).findByText("2")).closest("a")!.getAttribute("href")).toBe("/events?buoy=B01");

    // A retired buoy: its record and when it stopped.
    expect(within(row(/N01/)).getByText("Jun 8, 2004 – Oct 8, 2021")).toBeTruthy();
    expect(within(row(/N01/)).getByText("No data since Oct 8, 2021")).toBeTruthy();
    expect(within(row(/N01/)).getByText("0").closest("a")!.getAttribute("href")).toBe("/events?buoy=N01");

    // Anywhere on a row leads to its buoy.
    fireEvent.click(within(row(/N01/)).getByText("No data since Oct 8, 2021"));
    expect(screen.getByText("At /buoys/N01")).toBeTruthy();
  });

  it("shows the buoys while their heatwaves are still loading", async () => {
    serve({ "/api/buoys": buoys });
    renderPage();

    expect(await screen.findByRole("link", { name: /B01/ })).toBeTruthy();
    expect(within(row(/B01/)).getByText("…")).toBeTruthy();
  });

  it("says it's loading until the buoys arrive", () => {
    serve({});
    renderPage();

    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows an empty list when there are no buoys yet", async () => {
    serve({ "/api/buoys": [], "/api/events": [] });
    renderPage();

    expect(await screen.findByRole("heading", { name: "The buoys" })).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(1); // the header
  });

  it("says when it couldn't reach the API, and tries again", async () => {
    const responses: Record<string, unknown> = { "/api/buoys": 503, "/api/events": [] };
    serve(responses);
    renderPage();

    expect(await screen.findByText("Couldn't reach the API.")).toBeTruthy();
    responses["/api/buoys"] = buoys;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("link", { name: /B01/ })).toBeTruthy();
    expect(screen.queryByText("Couldn't reach the API.")).toBeNull();
  });
});
