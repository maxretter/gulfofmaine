import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keys } from "../api/queries";
import type { Buoy, Condition } from "../api/types";
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
});
