// Overview page: buoy map and heatwave-days heatmap, both at the selected depth.
"use strict";

(() => {
  const { colors, heatDays } = Charts;
  const buoys = JSON.parse(document.getElementById("buoys-data").textContent);
  const annualChart = document.getElementById("annual-chart");
  const depth = Number(annualChart.dataset.depth);

  drawMap();
  drawAnnual();

  function markerStyle(condition) {
    const ring = { color: colors.surface, weight: 2, opacity: 1, fillOpacity: 1, radius: 9 };
    switch (condition.state) {
      case "heatwave":
        return { ...ring, fillColor: colors.category[condition.category] };
      case "above_threshold":
        return { ...ring, color: colors.category[1], weight: 3, fillColor: colors.surface };
      case "normal":
        return { ...ring, fillColor: colors.muted };
      default:
        return { ...ring, color: colors.axis, weight: 2, fillOpacity: 0, radius: 7 };
    }
  }

  function drawMap() {
    const map = L.map("map", { scrollWheelZoom: false, attributionControl: true });
    // OpenStreetMap's standard tiles (fine for low traffic, with attribution),
    // desaturated in CSS so the status colours carry the map.
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 12,
    }).addTo(map);

    const points = [];
    for (const buoy of buoys) {
      if (buoy.latitude == null) continue;
      const condition = buoy.series.find((s) => s.depth === depth);
      const point = [buoy.latitude, buoy.longitude];
      points.push(point);
      L.circleMarker(point, markerStyle(condition))
        .bindTooltip(buoy.id, { permanent: true, direction: "right", offset: [10, 0], className: "buoy-label" })
        .on("click", () => (window.location.href = `/buoys/${buoy.id}`))
        .addTo(map);
    }
    map.fitBounds(points, { padding: [40, 40] });
  }

  async function drawAnnual() {
    let years;
    try {
      years = await Charts.fetchJSON(`/api/annual?depth=${depth}`);
    } catch (error) {
      Charts.showNote(annualChart, "Couldn't load the yearly summary.");
      throw error;
    }
    if (!years.length) return Charts.showNote(annualChart, "No data yet.");

    // A year counts only if at least half of it (so far, for this year) was observed.
    const now = new Date();
    const daysIn = (year) => {
      const start = Date.UTC(year, 0, 1);
      const end = Math.min(Date.UTC(year + 1, 0, 1), now.getTime());
      return Math.round((end - start) / 86400000);
    };
    const cells = years.map((d) => ({ ...d, enough: d.observed_days >= daysIn(d.year) / 2 }));
    const [first, last] = d3.extent(cells, (d) => d.year);
    const allYears = d3.range(first, last + 1);
    const buoyIds = buoys.map((b) => b.id);
    const names = new Map(buoys.map((b) => [b.id, b.name]));

    const describe = (d) =>
      d.enough
        ? `${d.buoy_id} ${names.get(d.buoy_id)}, ${d.year}\n${d.heatwave_days} heatwave days\n${d.observed_days} days observed`
        : `${d.buoy_id} ${names.get(d.buoy_id)}, ${d.year}\nToo little data (${d.observed_days} days observed)`;

    const render = () => {
      const width = Math.max(annualChart.clientWidth, 640);
      annualChart.replaceChildren(
        Plot.plot({
          width,
          height: 44 + buoyIds.length * 30,
          marginLeft: 44,
          style: Charts.plotStyle,
          x: { domain: allYears, label: null, tickFormat: (y) => (y % 5 === 0 || width > 900 ? String(y) : "") },
          y: { domain: buoyIds, label: null },
          color: { type: "identity" },
          marks: [
            Plot.cell(cells.filter((d) => d.enough), {
              x: "year",
              y: "buoy_id",
              fill: (d) => heatDays.bin(d.heatwave_days).color,
              inset: 1,
              rx: 3,
            }),
            Plot.cell(cells.filter((d) => !d.enough), {
              x: "year",
              y: "buoy_id",
              fill: colors.surface,
              stroke: colors.axis,
              inset: 1.5,
              rx: 3,
            }),
            Plot.tip(cells, Plot.pointer({ x: "year", y: "buoy_id", title: describe })),
          ],
        }),
      );
    };
    render();
    Charts.onResize(render);

    const legend = document.getElementById("annual-legend");
    for (const bin of [...heatDays.bins, { label: "Too little data", color: colors.surface, outline: true }]) {
      const item = document.createElement("span");
      item.className = "state";
      const swatch = document.createElement("span");
      swatch.className = "swatch square";
      swatch.style.background = bin.color;
      if (bin.outline || bin.min === 0) swatch.style.boxShadow = `inset 0 0 0 1px ${colors.axis}`;
      item.append(swatch, bin.label + (bin.min === 0 ? " days" : ""));
      legend.append(item);
    }

    Charts.bindTableToggle("annual", () => ({
      columns: [
        { label: "Buoy" },
        { label: "Year", numeric: true },
        { label: "Heatwave days", numeric: true },
        { label: "Days observed", numeric: true },
      ],
      rows: cells.map((d) => [`${d.buoy_id} ${names.get(d.buoy_id)}`, d.year, d.enough ? d.heatwave_days : "–", d.observed_days]),
    }));
  }
})();
