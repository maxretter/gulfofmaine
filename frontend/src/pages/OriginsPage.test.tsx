import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Buoy, Condition, HeatwaveEvent, Origin, OriginRules } from "../api/types";
import * as production from "../fixtures/production";
import { OriginsPage } from "./OriginsPage";

// The chart of the year at every buoy has tests of its own; here, only which year and depth it's given.
vi.mock("../components/YearByBuoy", () => ({
  YearByBuoy: ({ year, depth, buoys }: { year: number; depth: number; buoys: Buoy[] }) => (
    <p>
      {year} at {depth} m, at {buoys.length} buoys
    </p>
  ),
}));

const rules = { depths: [20, 50] } as OriginRules;

/** A buoy whose data, at 20 and 50 m, runs from `first_date` to `date`. */
const buoy = (id: string, longitude: number, date: string, first_date = "2001-07-10"): Buoy => ({
  id,
  name: id,
  latitude: 43,
  longitude,
  series: [20, 50].map((depth) => ({ depth, state: "offline", first_date, date }) as Condition),
  satellite: null,
});

const heatwave = (buoy_id: string, depth: number, start_date: string, origin: Origin | null) =>
  ({ buoy_id, depth, start_date, end_date: start_date, origin }) as HeatwaveEvent;

// At 50 m: two offshore, one surface and one unclear; at 20 m, one surface.
const events = [
  heatwave("M01", 50, "2021-01-10", "offshore"),
  heatwave("B01", 50, "2021-04-02", "offshore"),
  heatwave("B01", 50, "2023-08-01", "surface"),
  heatwave("B01", 50, "2024-08-01", "unclear"),
  heatwave("B01", 20, "2024-05-01", "surface"),
  heatwave("B01", 1, "2024-05-01", null),
];

/** Answers each path, its query aside, with its body, or with an error if that's a status; any other never answers. */
function serve(responses: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const path = url.split("?")[0];
      if (!(path in responses)) return new Promise<Response>(() => {});
      const body = responses[path];
      return Promise.resolve(
        typeof body === "number" ? new Response("{}", { status: body }) : new Response(JSON.stringify(body)),
      );
    }),
  );
}

const everything = {
  "/api/buoys": [buoy("M01", -67.9, "2025-09-17"), buoy("B01", -70.4, "2025-11-30")],
  "/api/events": events,
  "/api/origin/rules": rules,
  "/api/onsets": { year: 2021, depth: 50, dates: [], buoys: [] },
};

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <OriginsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const depthSelects = () => screen.getAllByRole<HTMLSelectElement>("combobox", { name: "Depth" });
const yearSelect = () => screen.getByRole<HTMLSelectElement>("combobox", { name: "Year" });
const listLink = () => screen.getByRole("link", { name: "list them all" }).getAttribute("href");

beforeEach(() => {
  // jsdom has no layout: the charts never get a width, so only their frames, legends and tables render.
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

describe("OriginsPage", () => {
  it("counts each origin at 50 m, and shows 2021 out of every year to the newest data", async () => {
    serve(everything);
    renderAt("/origins");

    expect(screen.getByRole("heading", { level: 1, name: "Offshore or surface?" })).toBeTruthy();
    expect(await screen.findByText("2021 at 50 m, at 2 buoys")).toBeTruthy();
    expect(await screen.findByText("2 (50%)")).toBeTruthy(); // offshore
    expect(screen.getAllByText("1 (25%)")).toHaveLength(2); // surface and unclear
    expect(depthSelects().map((select) => select.value)).toEqual(["50", "50"]);
    expect(yearSelect().value).toBe("2021");
    const years = within(yearSelect()).getAllByRole("option").map((option) => option.textContent);
    expect([years[0], years.at(-1), years.length]).toEqual(["2025", "2001", 25]);
    expect(listLink()).toBe("/events?depth=50&year=2021");
  });

  it("names the depths labeled as the rules have them, as it read when written out on production's rules", async () => {
    const lead = () => document.querySelector(".lead")!.textContent;
    serve({ ...everything, "/api/origin/rules": production.rules });
    renderAt("/origins");

    await waitFor(() =>
      expect(lead()).toBe(
        "Each heatwave at 20 and 50 m is labeled by five signals read around its start: Offshore when they point to " +
          "warm water arriving at depth, Surface when they point to heat from the surface reaching down, and Unclear " +
          "when they don't agree. The labels are this site's own rules of thumb. How the labels are made.",
      ),
    );

    cleanup();
    serve({ ...everything, "/api/origin/rules": { ...production.rules, depths: [50] } });
    renderAt("/origins");

    await waitFor(() => expect(lead()).toMatch(/^Each heatwave at 50 m is labeled by five signals/));
  });

  it("takes the depth and year from the address, and either title's menu changes the depth of both", async () => {
    serve(everything);
    renderAt("/origins?depth=20&year=2024");

    expect(await screen.findByText("2024 at 20 m, at 2 buoys")).toBeTruthy();
    expect(await screen.findByText("1 (100%)")).toBeTruthy(); // surface, the one heatwave at 20 m
    expect(depthSelects().map((select) => select.value)).toEqual(["20", "20"]);
    expect(yearSelect().value).toBe("2024");
    expect(listLink()).toBe("/events?depth=20&year=2024");

    fireEvent.change(depthSelects()[1], { target: { value: "50" } });

    expect(depthSelects().map((select) => select.value)).toEqual(["50", "50"]);
    expect(screen.getByText("2 (50%)")).toBeTruthy();
    expect(screen.getByText("2024 at 50 m, at 2 buoys")).toBeTruthy();

    fireEvent.change(yearSelect(), { target: { value: "2023" } });

    expect(screen.getByText("2023 at 50 m, at 2 buoys")).toBeTruthy();
    expect(listLink()).toBe("/events?depth=50&year=2023");
  });

  it("shows 50 m and 2021 for a depth or year it has no heatwaves for", async () => {
    serve(everything);
    renderAt("/origins?depth=1&year=1999");

    expect(await screen.findByText("2 (50%)")).toBeTruthy();
    expect(await screen.findByText("2021 at 50 m, at 2 buoys")).toBeTruthy(); // the years known
    expect(depthSelects()[0].value).toBe("50");
    expect(yearSelect().value).toBe("2021");
  });

  it("offers the years of the buoys' records, as it read when written out on production's buoys", async () => {
    const offered = () => within(yearSelect()).getAllByRole("option").map((option) => option.textContent);
    serve({ ...everything, "/api/buoys": production.buoys });
    renderAt("/origins");

    expect(await screen.findByText("2021 at 50 m, at 7 buoys")).toBeTruthy();
    expect(offered()).toEqual(Array.from({ length: 26 }, (_, i) => String(2026 - i))); // 2026 back to 2001

    // Records that begin in 2004: a year before that isn't offered, nor taken from the address.
    cleanup();
    serve({ ...everything, "/api/buoys": [buoy("N01", -65.9, "2021-10-30", "2004-06-04")] });
    renderAt("/origins?year=2003");

    expect(await screen.findByText("2021 at 50 m, at 1 buoys")).toBeTruthy();
    expect(offered()).toEqual(Array.from({ length: 18 }, (_, i) => String(2021 - i))); // 2021 back to 2004

    cleanup();
    renderAt("/origins?year=2004");

    expect(await screen.findByText("2004 at 50 m, at 1 buoys")).toBeTruthy();
  });

  it("says when the heatwaves didn't load, and offers both depths without the rules", async () => {
    serve({ "/api/events": 500, "/api/origin/rules": 500 });
    renderAt("/origins");

    expect(await screen.findByText("Couldn't load the heatwaves.")).toBeTruthy();
    const depths = within(depthSelects()[0]).getAllByRole("option").map((option) => option.textContent);
    expect(depths).toEqual(["20 m", "50 m"]);
    // Every heatwave in the year waits for the buoys.
    expect(screen.getByText("Loading…")).toBeTruthy();
  });
});
