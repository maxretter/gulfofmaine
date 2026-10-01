import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Condition, State } from "../api/types";
import { categories } from "../lib/colors";
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

  it("names a paused heatwave by its category, as a heatwave on hold rather than none", () => {
    render(<StateBadge condition={condition("paused", { category: 2, category_name: "Strong", event_start: "2026-09-20" })} />);

    const badge = screen.getByText("Strong heatwave · paused");
    expect(badge.className).toBe("state");
    const swatch = badge.querySelector(".swatch") as HTMLElement;
    // A dashed outline in the category's color, which no other state uses.
    expect(swatch.style.background).toBe("transparent");
    expect(swatch.style.borderStyle).toBe("dashed");
    // jsdom gives the color back as rgb().
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(categories[2].color.slice(i, i + 2), 16));
    expect(swatch.style.borderColor).toBe(`rgb(${r}, ${g}, ${b})`);
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

  it("puts a paused heatwave in the legend after the categories, before above the threshold", () => {
    render(<StateLegend />);

    const labels = Array.from(document.querySelectorAll(".legend .state"), (each) => each.textContent);
    expect(labels.slice(0, 6)).toEqual(["Moderate", "Strong", "Severe", "Extreme", "Heatwave paused", "Above threshold"]);
  });
});
