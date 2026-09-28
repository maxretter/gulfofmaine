import { useState } from "react";

export interface Column {
  label: string;
  numeric?: boolean;
}

/**
 * The table twin of a chart, inside a native <details>. Rows are only
 * rendered while it's open, since some charts hold thousands of points.
 */
export function TableToggle({ columns, rows }: { columns: Column[]; rows: () => (string | number)[][] }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="table-view" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{open ? "Hide table" : "Show as table"}</summary>
      {open && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.label} scope="col" className={column.numeric ? "num" : undefined}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows().map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} className={columns[j].numeric ? "num" : undefined}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
