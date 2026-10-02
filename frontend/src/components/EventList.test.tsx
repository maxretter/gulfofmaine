import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HeatwaveEvent } from "../api/types";
import { EventList } from "./EventList";

afterEach(cleanup);

function heatwave(depth: number, start_date: string, origin: HeatwaveEvent["origin"]): HeatwaveEvent {
  return {
    buoy_id: "F01",
    depth,
    start_date,
    end_date: start_date,
    peak_date: start_date,
    duration: 12,
    max_intensity: 2.4,
    mean_intensity: 1.6,
    category: 2,
    category_name: "Strong",
    origin,
    status: "ended",
  };
}

describe("EventList", () => {
  it("gives every heatwave a Details link, beside its origin label when it has one", () => {
    const onZoom = vi.fn();
    render(
      <MemoryRouter>
        <EventList events={[heatwave(20, "2021-06-10", "offshore"), heatwave(1, "2021-07-02", null)]} onZoom={onZoom} />
      </MemoryRouter>,
    );
    const [labelled, unlabelled] = screen.getAllByRole("listitem");

    // The label is a label, not the link: the link always reads Details.
    expect(within(labelled).getByText("Offshore").closest("a")).toBeNull();
    expect(within(labelled).getByRole("link", { name: "Details" }).getAttribute("href")).toBe(
      "/events/F01/20/2021-06-10",
    );
    expect(within(unlabelled).getByRole("link", { name: "Details" }).getAttribute("href")).toBe(
      "/events/F01/1/2021-07-02",
    );

    fireEvent.click(within(labelled).getByRole("button"));
    expect(onZoom).toHaveBeenCalledWith(expect.objectContaining({ start_date: "2021-06-10" }));
  });

  it("gives a last day only to a heatwave that has ended", () => {
    const ended = { ...heatwave(20, "2021-06-10", null), end_date: "2021-06-21" };
    render(
      <MemoryRouter>
        <EventList
          events={[ended, { ...ended, status: "ongoing" }, { ...ended, status: "paused" }]}
          onZoom={() => {}}
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole("button").map((button) => button.children[2].textContent)).toEqual([
      "Jun 10, 2021 – Jun 21, 2021",
      "Jun 10, 2021 – ongoing",
      "Jun 10, 2021 – Jun 21, 2021, paused",
    ]);
  });
});
