// Shared by the overview and buoy pages: colours, formatting, table views.
"use strict";

const Charts = (() => {
  const style = getComputedStyle(document.documentElement);
  const token = (name) => style.getPropertyValue(name).trim();

  const colors = {
    ink: token("--ink"),
    ink2: token("--ink-2"),
    muted: token("--muted"),
    axis: token("--axis"),
    grid: token("--grid"),
    surface: token("--surface"),
    neutral: token("--neutral"),
    observed: token("--observed"),
    category: { 1: token("--cat-1"), 2: token("--cat-2"), 3: token("--cat-3"), 4: token("--cat-4") },
  };

  // Heatwave days in a year, binned. Same hue family as the categories, but
  // a separate ordinal ramp: it counts days, it doesn't grade intensity.
  const heatDays = {
    bins: [
      { min: 0, label: "0", color: colors.neutral },
      { min: 1, label: "1–14", color: "#eba26c" },
      { min: 15, label: "15–29", color: "#e27b3a" },
      { min: 30, label: "30–59", color: "#cf5317" },
      { min: 60, label: "60–99", color: "#a1321a" },
      { min: 100, label: "100+", color: "#5a1507" },
    ],
    bin(days) {
      return this.bins.findLast((bin) => days >= bin.min);
    },
  };

  const minus = (text) => text.replace("-", "−");
  const formatTemp = (value) => (value == null ? "–" : `${value.toFixed(1)} °C`);
  const formatSigned = (value) => {
    if (value == null) return "–";
    const rounded = value.toFixed(1);
    if (Number(rounded) === 0) return "0.0 °C";
    return minus(`${value > 0 ? "+" : ""}${rounded} °C`);
  };
  const formatDate = d3.utcFormat("%b %-d, %Y");

  const plotStyle = { fontFamily: token("--font"), fontSize: "12px", color: colors.ink2, overflow: "visible" };

  async function fetchJSON(url) {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return response.json();
  }

  // Replace a container's content with a message, e.g. when a request fails.
  function showNote(container, text) {
    const note = document.createElement("p");
    note.className = "chart-note";
    note.textContent = text;
    container.replaceChildren(note);
  }

  // Every chart has a table twin. `build` returns {columns, rows} for the
  // current data; the table is (re)built each time it is shown.
  function bindTableToggle(name, build) {
    const button = document.querySelector(`[data-toggle-table="${name}"]`);
    const container = document.getElementById(`${name}-table`);
    if (!button || !container) return () => {};

    const render = () => {
      const { columns, rows } = build();
      const table = document.createElement("table");
      const head = table.createTHead().insertRow();
      for (const column of columns) {
        const th = document.createElement("th");
        th.scope = "col";
        th.textContent = column.label;
        if (column.numeric) th.className = "num";
        head.append(th);
      }
      const body = table.createTBody();
      for (const row of rows) {
        const tr = body.insertRow();
        columns.forEach((column, i) => {
          const td = tr.insertCell();
          td.textContent = row[i];
          if (column.numeric) td.className = "num";
        });
      }
      container.replaceChildren(table);
    };

    button.addEventListener("click", () => {
      const show = container.hidden;
      container.hidden = !show;
      button.setAttribute("aria-expanded", String(show));
      button.textContent = show ? "Hide table" : "Show as table";
      if (show) render();
    });
    // Callers invoke this after new data loads, to refresh an open table.
    return () => {
      if (!container.hidden) render();
    };
  }

  function onResize(callback) {
    let frame;
    new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(callback);
    }).observe(document.querySelector("main"));
  }

  return { colors, heatDays, formatTemp, formatSigned, formatDate, plotStyle, fetchJSON, showNote, bindTableToggle, onResize };
})();
