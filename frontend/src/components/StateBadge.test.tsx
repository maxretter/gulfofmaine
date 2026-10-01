import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Condition, State } from "../api/types";
import { StateBadge, StateLegend } from "./StateBadge";

afterEach(cleanup);

const condition = (state: State, overrides: Partial<Condition> = {}) =>
  ({ state, category: null, date: "2026-09-29", days_above: 0, ...overrides }) as Condition;

describe("StateBadge", () => {
  it("says a depth without a normal has none, muted, rather than that it has no heatwave", () => {
    render(<StateBadge condition={condition("no_normal")} />);

    const badge = screen.getByText("No normal");
    expect(badge.className).toBe("state muted");
    expect(screen.queryByText("No heatwave")).toBeNull();
  });

  it("keeps the other states' labels", () => {
    render(
      <>
        <StateBadge condition={condition("normal")} />
        <StateBadge condition={condition("offline", { date: "2025-09-14" })} />
      </>,
    );

    expect(screen.getByText("No heatwave").className).toBe("state");
    expect(screen.getByText("No data since Sep 14, 2025").className).toBe("state muted");
  });

  it("is in the legend, between no heatwave and no recent data", () => {
    render(<StateLegend />);

    const labels = Array.from(document.querySelectorAll(".legend .state"), (each) => each.textContent);
    expect(labels.slice(-3)).toEqual(["No heatwave", "No normal", "No recent data"]);
  });
});
