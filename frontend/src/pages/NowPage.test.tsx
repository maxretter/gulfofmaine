import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keys } from "../api/queries";
import type { Buoy, Condition, Method } from "../api/types";
import { NowPage } from "./NowPage";

function condition(depth: number, state: Condition["state"]): Condition {
  return {
    depth,
    dataset_id: `M01_ocean_${String(depth).padStart(3, "0")}m`,
    erddap_url: "",
    state,
    first_date: "2003-07-10",
    date: "2026-09-28",
    temperature: 11.2,
    climatology: 10.1,
    anomaly: 1.1,
    threshold: 11.8,
    days_above: 0,
    category: null,
    category_name: null,
    event_start: null,
    synced_at: "2026-09-29T01:20:00Z",
    reading_at: "2026-09-29T01:00:00Z",
    reading: 11.4,
  };
}

/** As /api/method sends it. */
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

const buoys: Buoy[] = [
  {
    id: "M01",
    name: "Jordan Basin",
    latitude: 43.5,
    longitude: -67.9,
    series: [condition(1, "normal"), condition(20, "normal"), condition(50, "normal"), condition(100, "heatwave")],
    satellite: null,
  },
];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NowPage", () => {
  it("shows a depth it doesn't offer, such as /?depth=100, at the first it does, as its menu says", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(keys.buoys, buoys);
    client.setQueryData(keys.method, method);
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/?depth=100"]}>
          <NowPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Depth" }).value).toBe("1");
    expect(screen.getByText("The one buoy reporting from 1 m isn't in a heatwave.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /M01/ }).getAttribute("href")).toBe("/buoys/M01");
  });

  it("states the method with the API's numbers, and offers the map's depths", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(keys.buoys, buoys);
    client.setQueryData(keys.method, { ...method, baseline_start: 1991, min_duration: 7, percentile: 95, depths: [1, 20] });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <NowPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(document.querySelector(".lead")?.textContent).toBe(
      "Daily water temperature at 1 and 20 meters on the University of Maine's buoys, against each spot's 1991–2022 " +
        "normal. A marine heatwave is seven or more days above the 95th percentile for the time of year.",
    );
    const menu = screen.getByRole<HTMLSelectElement>("combobox", { name: "Depth" });
    expect([...menu.options].map((option) => option.textContent)).toEqual(["1 m", "20 m"]);
  });
});
