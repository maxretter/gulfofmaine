// Buoy page: one chart per depth, sharing a time axis, for the chosen period.
"use strict";

(() => {
  const { colors } = Charts;
  const container = document.getElementById("series-charts");
  const buoy = container.dataset.buoy;
  const depths = container.dataset.depths.split(",").map(Number);
  const latest = container.dataset.latest; // newest day with data, YYYY-MM-DD
  const period = document.getElementById("period");

  let loaded = null; // {start, end, panels: [{depth, days, eventDays}]}
  let events = null;

  const refreshTable = Charts.bindTableToggle("series", () => ({
    columns: [
      { label: "Date" },
      { label: "Depth", numeric: true },
      { label: "Daily mean", numeric: true },
      { label: "Normal", numeric: true },
      { label: "Threshold", numeric: true },
    ],
    rows: loaded.panels.flatMap(({ depth, days }) =>
      days.map((d) => [
        d.date,
        `${depth} m`,
        Charts.formatTemp(d.temperature),
        Charts.formatTemp(d.climatology),
        Charts.formatTemp(d.threshold),
      ]),
    ),
  }));

  // Long event lists start collapsed to the newest dozen; without JavaScript
  // every row stays visible.
  const showAll = document.getElementById("show-all-events");
  if (showAll) {
    const table = document.querySelector("table.events");
    table.classList.add("collapsed");
    showAll.hidden = false;
    showAll.addEventListener("click", () => {
      table.classList.remove("collapsed");
      showAll.remove();
    });
  }

  period.addEventListener("change", () => load(period.value));
  Charts.onResize(() => loaded && render());
  load("recent");

  function range(choice) {
    const end = new Date(`${latest}T00:00:00Z`);
    if (choice === "recent") return [d3.utcDay.offset(end, -364), end];
    const year = Number(choice);
    return [new Date(Date.UTC(year, 0, 1)), d3.min([new Date(Date.UTC(year, 11, 31)), end])];
  }

  async function load(choice) {
    const [start, end] = range(choice);
    const iso = d3.utcFormat("%Y-%m-%d");
    container.classList.add("loading"); // keep the old charts visible while fetching
    try {
      events ??= await Charts.fetchJSON(`/api/events?buoy_id=${buoy}`);
      const panels = await Promise.all(
        depths.map(async (depth) => {
          const days = await Charts.fetchJSON(
            `/api/buoys/${buoy}/${depth}/daily?start=${iso(start)}&end=${iso(end)}`,
          );
          for (const d of days) d.date = new Date(`${d.date}T00:00:00Z`);
          return { depth, days, eventDays: eventDays(days, events.filter((e) => e.depth === depth)) };
        }),
      );
      loaded = { start, end, panels };
      render();
      refreshTable();
    } catch (error) {
      Charts.showNote(container, "Couldn't load the temperature series.");
      throw error;
    } finally {
      container.classList.remove("loading");
    }
  }

  // The days inside each heatwave, with the band between threshold and
  // temperature to shade. Days in a joined gap may sit below the threshold,
  // so the band is clamped to zero height there.
  function eventDays(days, depthEvents) {
    const shaded = [];
    depthEvents.forEach((event, index) => {
      const start = new Date(`${event.start_date}T00:00:00Z`);
      const end = new Date(`${event.end_date}T00:00:00Z`);
      for (const d of days) {
        if (d.date < start || d.date > end) continue;
        const top = d.temperature == null ? d.threshold : Math.max(d.temperature, d.threshold);
        shaded.push({ date: d.date, low: d.threshold, high: top, event: index, category: event.category });
      }
    });
    return shaded;
  }

  function render() {
    const width = container.clientWidth;
    const charts = loaded.panels.map(({ depth, days, eventDays }) => {
      const panel = document.createElement("div");
      const title = document.createElement("p");
      title.className = "panel-title";
      title.textContent = `${depth} m`;
      const observed = days.filter((d) => d.temperature != null);

      const tip = (d) =>
        [
          Charts.formatDate(d.date),
          d.temperature == null ? "No data" : `${Charts.formatTemp(d.temperature)} daily mean`,
          `${Charts.formatTemp(d.climatology)} normal`,
          `${Charts.formatTemp(d.threshold)} threshold`,
        ].join("\n");

      panel.append(
        title,
        observed.length === 0
          ? Object.assign(document.createElement("p"), { className: "chart-note", textContent: "No data in this period." })
          : Plot.plot({
              width,
              height: 190,
              marginLeft: 40,
              marginRight: 12,
              style: Charts.plotStyle,
              x: { type: "utc", domain: [loaded.start, loaded.end], label: null },
              y: { label: "°C", grid: true, nice: true },
              color: { type: "identity" },
              marks: [
                Plot.areaY(eventDays, {
                  x: "date",
                  y1: "low",
                  y2: "high",
                  z: "event",
                  fill: (d) => colors.category[d.category],
                }),
                Plot.lineY(days, { x: "date", y: "climatology", stroke: colors.muted, strokeWidth: 1.5 }),
                Plot.lineY(days, {
                  x: "date",
                  y: "threshold",
                  stroke: colors.ink2,
                  strokeWidth: 1.25,
                  strokeDasharray: "4,3",
                }),
                // Missing days are null, which breaks the line: gaps stay visible.
                Plot.lineY(days, { x: "date", y: "temperature", stroke: colors.observed, strokeWidth: 2 }),
                Plot.ruleX(days, Plot.pointerX({ x: "date", stroke: colors.axis })),
                Plot.tip(days, Plot.pointerX({ x: "date", y: (d) => d.temperature ?? d.threshold, title: tip })),
              ],
            }),
      );
      return panel;
    });
    container.replaceChildren(...charts);
  }
})();
