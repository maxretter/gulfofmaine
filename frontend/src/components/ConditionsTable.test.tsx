import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import type { Buoy, Condition } from "../api/types";
import { ConditionsTable } from "./ConditionsTable";

afterEach(cleanup);

function condition(overrides: Partial<Condition>): Condition {
  return {
    depth: 1,
    dataset_id: "A01_ocean_001m",
    erddap_url: "https://data.neracoos.org/erddap/tabledap/A01_ocean_001m.html",
    state: "normal",
    first_date: "2001-07-10",
    date: "2026-09-27",
    temperature: 14.9,
    climatology: 16.2,
    anomaly: -1.3,
    threshold: 17.6,
    days_above: 0,
    category: null,
    category_name: null,
    event_start: null,
    synced_at: "2026-09-28T16:51:00Z",
    reading_at: "2026-09-28T16:00:00Z",
    reading: 15.1,
    ...overrides,
  };
}

const buoys: Buoy[] = [
  { id: "A01", name: "Massachusetts Bay", latitude: 42.5, longitude: -70.6, series: [condition({})], satellite: null },
  {
    id: "B01",
    name: "Western Maine Shelf",
    latitude: 43.2,
    longitude: -70.4,
    series: [
      condition({
        state: "heatwave",
        temperature: 17.6,
        anomaly: 2.2,
        category: 1,
        category_name: "Moderate",
        event_start: "2026-09-21",
      }),
    ],
    satellite: null,
  },
  {
    id: "M01",
    name: "Jordan Basin",
    latitude: 43.5,
    longitude: -67.9,
    series: [condition({ state: "offline", date: "2025-09-14", anomaly: 2.1 })],
    satellite: null,
  },
];

const pathFor = (buoy: string) => `/buoys/${buoy}`;

function Where() {
  const location = useLocation();
  return <p>At {location.pathname}</p>;
}

function renderTable() {
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<ConditionsTable buoys={buoys} depth={1} pathFor={pathFor} />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ConditionsTable", () => {
  it("labels every state in words, not just color", () => {
    renderTable();
    expect(screen.getByText("No heatwave")).toBeTruthy();
    expect(screen.getByText("Moderate heatwave · day 7")).toBeTruthy();
    expect(screen.getByText("No data since Sep 14, 2025")).toBeTruthy();
    expect(screen.getByText("−1.3 °C")).toBeTruthy();
  });

  it("links each buoy to its page, and opens it from anywhere on the row", () => {
    renderTable();
    expect(screen.getByRole("link", { name: /B01/ }).getAttribute("href")).toBe("/buoys/B01");

    fireEvent.click(screen.getByText("Moderate heatwave · day 7"));

    expect(screen.getByText("At /buoys/B01")).toBeTruthy();
  });
});
