import type { DataProduct, DataVariable } from "../api/types";
import { formatBytes } from "../lib/format";

const FORMATS = { nc: "NetCDF", csv: "CSV" } as const;

/** Each buoy's daily files by depth, then the events table, with a download link per format. */
export function ProductTable({ products, names }: { products: DataProduct[]; names: Map<string, string> }) {
  const byBuoy = new Map<string, DataProduct[]>();
  for (const product of products) {
    if (product.buoy_id != null) byBuoy.set(product.buoy_id, [...(byBuoy.get(product.buoy_id) ?? []), product]);
  }
  const events = products.find((product) => product.buoy_id == null);
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Buoy</th>
            <th scope="col" className="num">
              Depth
            </th>
            {Object.values(FORMATS).map((format) => (
              <th key={format} scope="col" className="num">
                {format}
              </th>
            ))}
          </tr>
        </thead>
        {[...byBuoy].map(([buoy, depths]) => (
          <tbody key={buoy}>
            {depths.map((product, i) => (
              <tr key={product.name}>
                {i === 0 && (
                  <th scope="rowgroup" rowSpan={depths.length}>
                    {buoy}
                    <span className="buoy-name">{names.get(buoy)}</span>
                  </th>
                )}
                <td className="num">{product.depth} m</td>
                <Downloads product={product} label={`${buoy} ${product.depth} m`} />
              </tr>
            ))}
          </tbody>
        ))}
        {events && (
          <tbody>
            <tr>
              <th scope="row">All buoys</th>
              <td className="num">Every heatwave</td>
              <Downloads product={events} label="Events table" />
            </tr>
          </tbody>
        )}
      </table>
    </div>
  );
}

function Downloads({ product, label }: { product: DataProduct; label: string }) {
  return (
    <>
      {(Object.keys(FORMATS) as (keyof typeof FORMATS)[]).map((format) => {
        const file = product.files.find((f) => f.format === format);
        return (
          <td key={format} className="num">
            {file ? (
              <a href={file.url} download aria-label={`${label}, ${FORMATS[format]}, ${formatBytes(file.size)}`}>
                {formatBytes(file.size)}
              </a>
            ) : (
              "–"
            )}
          </td>
        );
      })}
    </>
  );
}

/** CF units as a reader would say them: "1" is practical salinity's (it has no unit), flags have none. */
function units(variable: DataVariable): string {
  if (variable.units === "1") return "1 (practical salinity)";
  return variable.units ?? "flag";
}

/** The daily files' variables: name and units, then what it is, with flag meanings and the CF standard name. */
export function VariableTable({ variables }: { variables: DataVariable[] }) {
  return (
    <div className="table-scroll">
      <table className="variables">
        <thead>
          <tr>
            <th scope="col">Variable and units</th>
            <th scope="col">Description</th>
          </tr>
        </thead>
        <tbody>
          {variables.map((variable) => (
            <tr key={variable.name}>
              <th scope="row">
                <code>{variable.name}</code>
                <span className="secondary">{units(variable)}</span>
              </th>
              <td>
                {variable.long_name}
                {variable.flag_meanings && (
                  <span className="secondary">
                    {variable.flag_meanings
                      .split(" ")
                      .map((meaning, value) => `${value} ${meaning}`)
                      .join(", ")}
                  </span>
                )}
                {variable.standard_name && <span className="secondary">CF: {variable.standard_name}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
