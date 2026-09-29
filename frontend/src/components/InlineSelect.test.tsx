import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InlineSelect } from "./InlineSelect";

afterEach(cleanup);

describe("InlineSelect", () => {
  it("shows the value in use and hands back the chosen one as it was given, not as text", () => {
    const onChange = vi.fn();
    render(
      <h2>
        Latest daily mean at{" "}
        <InlineSelect
          label="Depth"
          value={1}
          options={[1, 20, 50].map((d) => ({ value: d, label: `${d} m` }))}
          onChange={onChange}
        />
      </h2>,
    );
    const select = screen.getByRole("combobox", { name: "Depth" }) as HTMLSelectElement;
    expect(select.selectedOptions[0].textContent).toBe("1 m");

    fireEvent.change(select, { target: { value: "50" } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(50);
  });
});
