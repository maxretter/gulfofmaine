import { divIcon, latLngBounds } from "leaflet";
import { useState } from "react";
import { AttributionControl, CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip } from "react-leaflet";

import type { Buoy } from "../api/types";
import { colors } from "../lib/colors";

type Point = [number, number];

// On the shelf edge south of the Northeast Channel, where slope water comes in.
const SLOPE: Point = [41.75, -65.55];

/**
 * A small map that holds still: the buoys, east to west, joined in the order slope water reaches them once it enters
 * through the Northeast Channel. The key to the rows of the chart beside it.
 */
export function PathMap({ buoys }: { buoys: Buoy[] }) {
  const path: Point[] = [SLOPE, ...buoys.map((b): Point => [b.latitude!, b.longitude!])];
  // Read once: the map frames the path on mount.
  const [bounds] = useState(() => latLngBounds(path));
  const legs = path.slice(1).map((to, i) => ({ from: path[i], to }));

  return (
    <MapContainer
      bounds={bounds}
      boundsOptions={{ paddingTopLeft: [16, 16], paddingBottomRight: [44, 16] }}
      className="map path-map"
      zoomSnap={0.25}
      dragging={false}
      zoomControl={false}
      scrollWheelZoom={false}
      doubleClickZoom={false}
      touchZoom={false}
      boxZoom={false}
      keyboard={false}
      attributionControl={false}
      aria-label="Map of the buoys, joined from the Northeast Channel westward: the order of the rows"
    >
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        maxZoom={12}
      />
      <AttributionControl prefix={false} />
      <Polyline positions={path} interactive={false} pathOptions={{ color: colors.ink2, weight: 1.5, dashArray: "3 4" }} />
      {legs.map(({ from, to }) => (
        <Marker
          key={`${to[0]},${to[1]}`}
          position={[(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]}
          icon={chevron(heading(from, to))}
          interactive={false}
          keyboard={false}
        />
      ))}
      {buoys.map((buoy, i) => {
        // A label goes to the right, unless the leg into the buoy arrives from there.
        const above = Math.abs(heading(legs[i].from, legs[i].to)) > 150;
        return (
          <CircleMarker
            key={buoy.id}
            center={[buoy.latitude!, buoy.longitude!]}
            radius={4}
            interactive={false}
            pathOptions={{ color: colors.surface, weight: 1.5, fillColor: colors.ink, fillOpacity: 1 }}
          >
            <Tooltip
              permanent
              direction={above ? "top" : "right"}
              offset={above ? [0, -4] : [6, 0]}
              className="buoy-label path-label"
            >
              {buoy.id}
            </Tooltip>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}

/** The on-screen direction from one point to the next, in degrees clockwise from east (web Mercator). */
function heading([lat1, lon1]: Point, [lat2, lon2]: Point): number {
  const mercator = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const dx = ((lon2 - lon1) * Math.PI) / 180;
  const dy = mercator(lat1) - mercator(lat2); // screen y runs down
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

function chevron(angle: number) {
  return divIcon({
    className: "path-arrow",
    html: `<svg viewBox="-6 -6 12 12" width="12" height="12" aria-hidden="true"><path d="M-2,-4L2.5,0L-2,4" transform="rotate(${Math.round(angle)})"/></svg>`,
    iconSize: [12, 12],
  });
}
