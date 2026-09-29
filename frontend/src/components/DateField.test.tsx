import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DateField } from "./DateField";

afterEach(cleanup);

const field = () => screen.getByLabelText("From") as HTMLInputElement;

function renderField(value: string, onCommit = vi.fn()) {
  const view = render(
    <label>
      From <DateField value={value} min="2001-07-10" max="2026-09-29" onCommit={onCommit} />
    </label>,
  );
  return { onCommit, rerender: (next: string) => view.rerender(
    <label>
      From <DateField value={next} min="2001-07-10" max="2026-09-29" onCommit={onCommit} />
    </label>,
  ) };
}

describe("DateField", () => {
  it("commits a day once it is complete and in range, not the years on the way", () => {
    const { onCommit } = renderField("2025-09-30");
    for (const typed of ["0002-03-25", "0020-03-25", "0202-03-25"]) {
      fireEvent.change(field(), { target: { value: typed } });
      expect(field().value).toBe(typed);
    }
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.change(field(), { target: { value: "2021-03-25" } });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("2021-03-25");
  });

  it("puts back the day in use when left with one out of range", () => {
    renderField("2025-09-30");
    fireEvent.change(field(), { target: { value: "1999-01-01" } });
    fireEvent.blur(field());
    expect(field().value).toBe("2025-09-30");
  });

  it("follows a new value from outside", () => {
    const { rerender } = renderField("2025-09-30");
    rerender("2021-05-01");
    expect(field().value).toBe("2021-05-01");
  });

  it("follows a new value from outside after being typed in and left", () => {
    const { onCommit, rerender } = renderField("2025-09-30");
    fireEvent.change(field(), { target: { value: "2021-03-25" } });
    rerender(onCommit.mock.calls[0][0]);
    fireEvent.blur(field());
    rerender("2015-01-31");
    expect(field().value).toBe("2015-01-31");
  });

  it("keeps showing a typed day while its commit is on the way", () => {
    renderField("2025-09-30");
    fireEvent.change(field(), { target: { value: "2021-03-25" } });
    expect(field().value).toBe("2021-03-25");
  });

  it("keeps up with typing that outruns its commits", () => {
    // Typing a day of 15 over one of 15 passes through 01: two commits, the second back to where it began.
    const { onCommit, rerender } = renderField("2021-06-15");
    fireEvent.change(field(), { target: { value: "2021-06-01" } });
    fireEvent.change(field(), { target: { value: "2021-06-15" } });
    expect(onCommit.mock.calls).toEqual([["2021-06-01"], ["2021-06-15"]]);

    rerender("2021-06-01"); // the first commit lands
    expect(field().value).toBe("2021-06-15");
    rerender("2021-06-15"); // and the second
    expect(field().value).toBe("2021-06-15");
  });
});
