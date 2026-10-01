import { latLngBounds, type LatLngTuple } from "leaflet";
import { Fragment, useState } from "react";
import { CircleMarker, MapContainer, TileLayer, Tooltip } from "react-leaflet";

import { useLive } from "../api/live";
import type { Buoy } from "../api/types";
import { colors } from "../lib/colors";
import { stateLook } from "../lib/state";

/** Where the map looks when no buoy has a position yet, as on a database that hasn't synced: the whole Gulf. */
const GULF: LatLngTuple = [43.2, -68.3];
const GULF_ZOOM = 7;

interface Props {
  buoys: Buoy[];
  depth: number;
  onSelect: (buoy: string) => void;
}

export function BuoyMap({ buoys, depth, onSelect }: Props) {
  const { pulses } = useLive();
  const located = buoys.filter((buoy) => buoy.latitude !== null && buoy.longitude !== null);
  // Read once: the map frames the buoys on mount, then the view belongs to the user. Leaflet can't frame none.
  const [bounds] = useState(() =>
    located.length ? latLngBounds(located.map((buoy) => [buoy.latitude!, buoy.longitude!])) : null,
  );

  return (
    <MapContainer
      {...(bounds ? { bounds, boundsOptions: { padding: [40, 40] } } : { center: GULF, zoom: GULF_ZOOM })}
      scrollWheelZoom={false}
      className="map"
      aria-label={`Map of buoys, colored by heatwave status at ${depth} m`}
    >
      {/* OpenStreetMap's standard tiles: fine for low traffic, with attribution. */}
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        maxZoom={12}
      />
      {located.map((buoy) => {
        const condition = buoy.series.find((s) => s.depth === depth);
        if (!condition) return null;
        const { color, variant } = stateLook(condition);
        const center: [number, number] = [buoy.latitude!, buoy.longitude!];
        const style =
          variant === "dot"
            ? { color: colors.surface, weight: 2, fillColor: color, fillOpacity: 1 }
            : variant === "ring"
              ? { color, weight: 3, fillColor: colors.surface, fillOpacity: 1 }
              : variant === "dashed"
                ? { color, weight: 3, dashArray: "4 3", fillOpacity: 0 }
                : { color, weight: 2, fillOpacity: 0 };
        return (
          <Fragment key={buoy.id}>
            {pulses[buoy.id] && (
              // A ring that spreads and fades once when a new reading arrives; a new key replays it.
              <CircleMarker
                key={pulses[buoy.id]}
                center={center}
                radius={9}
                interactive={false}
                pathOptions={{ className: "pulse", color: colors.observed, weight: 2, fillOpacity: 0 }}
              />
            )}
            <CircleMarker
              center={center}
              radius={variant === "hollow" ? 7 : 9}
              pathOptions={style}
              eventHandlers={{ click: () => onSelect(buoy.id) }}
            >
              <Tooltip permanent direction="right" offset={[10, 0]} className="buoy-label">
                {buoy.id}
              </Tooltip>
            </CircleMarker>
          </Fragment>
        );
      })}
    </MapContainer>
  );
}
