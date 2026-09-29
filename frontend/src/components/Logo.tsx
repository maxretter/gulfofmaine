import { categories } from "../lib/colors";

/** The site's mark: the four heatwave categories side by side, Moderate to Extreme. public/favicon.svg draws the same. */
export function Logo() {
  return (
    <span className="logo" aria-hidden="true">
      {Object.values(categories).map(({ name, color }) => (
        <span key={name} style={{ background: color }} />
      ))}
    </span>
  );
}
