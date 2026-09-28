import { Link, NavLink, Outlet, ScrollRestoration } from "react-router";

import { useBuoys } from "../api/queries";
import { formatDate } from "../lib/format";

export function Layout() {
  return (
    <>
      <header className="site-header">
        <div className="wrap">
          <Link className="wordmark" to="/">
            <span className="dot" aria-hidden="true" />
            Gulf of Maine heatwaves
          </Link>
          <nav aria-label="Site">
            <NavLink to="/" end>
              Explorer
            </NavLink>
            <NavLink to="/events">Heatwaves</NavLink>
            <NavLink to="/methods">Methods</NavLink>
            <a href="/docs">API</a>
            <a href="https://github.com/maxretter/gom-heatwaves">Source</a>
          </nav>
        </div>
      </header>
      <main className="wrap">
        <Outlet />
      </main>
      <Footer />
      <ScrollRestoration />
    </>
  );
}

function Footer() {
  const buoys = useBuoys();
  const series = buoys.data?.flatMap((b) => b.series) ?? [];
  const dataThrough = series.map((s) => s.date).reduce<string | null>((a, b) => (b && (!a || b > a) ? b : a), null);
  const checked = series.map((s) => s.synced_at).reduce<string | null>((a, b) => (b && (!a || b > a) ? b : a), null);
  return (
    <footer className="site-footer">
      <div className="wrap">
        <p>
          {dataThrough && <>Data through {formatDate(dataThrough)} (UTC)</>}
          {checked && <>, last checked {new Date(checked).toUTCString().slice(5, 22)} UTC</>}
          {dataThrough && ". "}
          Observations from buoys operated by the{" "}
          <a href="https://gyre.umeoce.maine.edu">University of Maine Physical Oceanography Group</a>, served by{" "}
          <a href="https://data.neracoos.org/erddap">NERACOOS ERDDAP</a>. Not intended for navigation or legal use.
        </p>
        <p>An independent portfolio project; not affiliated with NERACOOS, GMRI or the University of Maine.</p>
      </div>
    </footer>
  );
}

export function NotFound() {
  return (
    <section className="intro">
      <h1>Page not found</h1>
      <p className="lead">
        <Link to="/">Back to the explorer</Link>
      </p>
    </section>
  );
}
