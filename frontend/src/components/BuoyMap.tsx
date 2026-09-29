import { latLngBounds } from "leaflet";
import { useState, type ReactNode } from "react";
import { CircleMarker, MapContainer, TileLayer, Tooltip } from "react-leaflet";

import { useLive } from "../api/live";
import type { Buoy } from "../api/types";
import { colors } from "../lib/colors";
import { stateLook } from "../lib/state";

interface Props {
  buoys: Buoy[];
  depth: number;
  selected: string;
  onSelect: (buoy: string) => void;
}

export function BuoyMap({ buoys, depth, selected, onSelect }: Props) {
  const { pulses } = useLive();
  const located = buoys.filter((buoy) => buoy.latitude !== null && buoy.longitude !== null);
  // Read once: the map frames the buoys on mount, then the view belongs to the user.
  const [bounds] = useState(() => latLngBounds(located.map((buoy) => [buoy.latitude!, buoy.longitude!])));

  return (
    <MapContainer
      bounds={bounds}
      boundsOptions={{ padding: [40, 40] }}
      scrollWheelZoom={false}
      className="map"
      aria-label={`Map of buoys, coloured by heatwave status at ${depth} m`}
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
              : { color, weight: 2, fillOpacity: 0 };
        return (
          <Highlight key={buoy.id} selected={buoy.id === selected} center={center}>
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
          </Highlight>
        );
      })}
    </MapContainer>
  );
}

/** Draws a halo behind its marker when that's the selected buoy. */
function Highlight({
  selected,
  center,
  children,
}: {
  selected: boolean;
  center: [number, number];
  children: ReactNode;
}) {
  return (
    <>
      {selected && (
        <CircleMarker
          center={center}
          radius={15}
          interactive={false}
          pathOptions={{ color: colors.ink, weight: 2, fillOpacity: 0 }}
        />
      )}
      {children}
    </>
  );
}
