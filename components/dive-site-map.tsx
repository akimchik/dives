"use client";

import { useEffect } from "react";
import L from "leaflet";
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from "react-leaflet";

// Leaflet's default marker icon references image paths that don't resolve correctly once bundled
// (a well-known Leaflet+webpack/turbopack issue -- the icon's own relative URL logic assumes a
// plain <script> tag setup, not a bundler). Pointing at the same package's own published assets on
// a CDN sidesteps that without vendoring the images.
const ICON_BASE = "https://unpkg.com/leaflet@1.9.4/dist/images";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Leaflet's own documented fix; no typed API for this.
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: `${ICON_BASE}/marker-icon-2x.png`,
  iconUrl: `${ICON_BASE}/marker-icon.png`,
  shadowUrl: `${ICON_BASE}/marker-shadow.png`,
});

const DEFAULT_CENTER: [number, number] = [20, 0];
const DEFAULT_ZOOM = 2;
const PICKED_ZOOM = 11;

// Recenters an already-mounted map smoothly (no remount/flicker) whenever the coordinates change,
// whether from a map click, picking a saved site, or typing into the lat/lng fields directly.
function Recenter({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap();

  useEffect(() => {
    map.setView([lat, lng], Math.max(map.getZoom(), PICKED_ZOOM));
  }, [lat, lng, map]);

  return null;
}

function ClickToPick({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(event) {
      onPick(event.latlng.lat, event.latlng.lng);
    },
  });

  return null;
}

/**
 * Shared by the dive-site picker (onPick set -- click anywhere to set the site's coordinates) and
 * the dive detail page's read-only preview (onPick omitted). OpenStreetMap tiles: free, no API key,
 * subject to OSM's own fair-use tile policy -- fine at this app's personal-logbook scale.
 */
export function DiveSiteMap({
  lat,
  lng,
  onPick,
  height = 220,
}: {
  lat: number | null;
  lng: number | null;
  onPick?: (lat: number, lng: number) => void;
  height?: number;
}) {
  const hasPoint = lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng);

  return (
    <div
      style={{ height }}
      className="overflow-hidden rounded-md border border-border"
      // The picker needs the click-to-set affordance to actually be discoverable.
      title={onPick ? "Click the map to set this site's location" : undefined}
    >
      <MapContainer
        center={hasPoint ? [lat, lng] : DEFAULT_CENTER}
        zoom={hasPoint ? PICKED_ZOOM : DEFAULT_ZOOM}
        style={{ height: "100%", width: "100%" }}
        // Preview mode doesn't need to be interactive at all -- it's just showing where the dive
        // was, not asking the viewer to do anything with the map.
        scrollWheelZoom={Boolean(onPick)}
        dragging={Boolean(onPick) || hasPoint}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {hasPoint ? <Marker position={[lat, lng]} /> : null}
        {hasPoint ? <Recenter lat={lat} lng={lng} /> : null}
        {onPick ? <ClickToPick onPick={onPick} /> : null}
      </MapContainer>
    </div>
  );
}
