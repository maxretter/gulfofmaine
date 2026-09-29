import { type ReactNode, useRef } from "react";

import { useElementWidth } from "../lib/useElementWidth";
import { type Column, TableToggle } from "./TableToggle";

interface Props {
  className?: string;
  /** Dims the chart while newer data loads, keeping the last one in view. */
  loading?: boolean;
  /** Shown in place of the chart when its data couldn't be loaded. */
  error?: string | false;
  /** Height reserved up front, so the page below doesn't jump when the data arrives. */
  minHeight?: number;
  /** Shown under the chart, above its table view. */
  legend?: ReactNode;
  /** The chart's table twin. */
  table?: { columns: Column[]; rows: () => (string | number)[][] };
  /** Draws the chart at the container's width, once that's known. */
  children: (width: number) => ReactNode;
}

/** The frame every chart sits in: width, loading, errors and the table view. */
export function Chart({ className, loading, error, minHeight, legend, table, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const classes = [className, loading && "loading"].filter(Boolean).join(" ");
  return (
    <>
      <div ref={ref} className={classes || undefined} style={minHeight ? { minHeight } : undefined}>
        {error ? <p className="note">{error}</p> : width > 0 && children(width)}
      </div>
      {legend}
      {table && <TableToggle columns={table.columns} rows={table.rows} />}
    </>
  );
}
