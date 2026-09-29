import { useCallback, useRef, useState } from "react";
import { Link, NavLink, Outlet, ScrollRestoration } from "react-router";

import { alertId, enteredHeatwave, LiveContext, useLiveFeed } from "../api/live";
import { useBuoys } from "../api/queries";
import type { StatusMessage } from "../api/types";
import { HeatwaveToasts } from "../components/HeatwaveToasts";
import { LiveIndicator } from "../components/LiveIndicator";
import { Logo } from "../components/Logo";
import { StripesBand } from "../components/Stripes";
import { latest } from "../lib/dates";
import { formatDate } from "../lib/format";

export function Layout() {
  const [alerts, setAlerts] = useState<StatusMessage[]>([]);
  // Each heatwave is announced once: today's mean is recomputed as readings arrive, and one near the threshold can
  // tip in and out of a heatwave more than once in an evening.
  const announced = useRef(new Set<string>());
  const live = useLiveFeed((message) => {
    if (!enteredHeatwave(message) || announced.current.has(alertId(message))) return;
    announced.current.add(alertId(message));
    setAlerts((shown) => [...shown, message]);
  });
  const dismiss = useCallback((id: string) => setAlerts((shown) => shown.filter((a) => alertId(a) !== id)), []);

  return (
    <LiveContext value={live}>
      <header className="site-header">
        <StripesBand />
        <div className="wrap">
          <div className="brand">
            <Link className="wordmark" to="/">
              <Logo />
              Gulf of Maine heatwaves
            </Link>
            <LiveIndicator />
          </div>
          <nav aria-label="Site">
            <div className="nav-main">
              <NavLink to="/" end>
                Now
              </NavLink>
              <NavLink to="/buoys">Buoys</NavLink>
              <NavLink to="/events">Heatwaves</NavLink>
              <NavLink to="/origins">Origins</NavLink>
              <NavLink to="/satellite">Satellite gap</NavLink>
            </div>
            <div className="nav-more">
              <NavLink to="/about">About</NavLink>
            </div>
          </nav>
        </div>
      </header>
      <main className="wrap">
        <Outlet />
      </main>
      <Footer />
      <HeatwaveToasts alerts={alerts} onDismiss={dismiss} />
      <ScrollRestoration />
    </LiveContext>
  );
}

function Footer() {
  const buoys = useBuoys();
  const series = buoys.data?.flatMap((b) => b.series) ?? [];
  const dataThrough = latest(series.map((s) => s.date));
  const checked = latest(series.map((s) => s.synced_at));
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
        <p>
          An independent portfolio project; not affiliated with NERACOOS, GMRI or the University of Maine.{" "}
          <a href="/docs">API documentation</a> · <a href="https://github.com/maxretter/gulfofmaine">Source code</a>
        </p>
      </div>
    </footer>
  );
}

export function NotFound() {
  return (
    <section className="intro">
      <h1>Page not found</h1>
      <p className="lead">
        <Link to="/">See every buoy now</Link>
      </p>
    </section>
  );
}
