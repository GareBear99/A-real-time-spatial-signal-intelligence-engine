# ARC v10 Offline Worldmap

ARC v10 Serverless Spatial Engine as an **offline world map plugin** —
multi-device tracking, RF propagation visualization, sensor mesh
simulation, triangulated location estimation, path history, and an
experimental room-inference stub. Runs entirely in the browser with
**zero network**.

## Base

Built off the FIRST one — the zip Gary gave us
(`arc_serverless_v10_complete.zip`). The zip is the authority for the
base engine. The companion repo is
https://github.com/GareBear99/A-real-time-spatial-signal-intelligence-engine
(`arc_serverless_v10_complete/` on main) — the repo copy and the zip are
identical. If the repo copy ever drifts from the zip, the zip is the
authority for the base.

**To make the Lucid install fetch this offline build**, replace
`arc_serverless_v10_complete/` in that repo with this package and push
to main. The install shape-check requires the offline markers
(`vendor/leaflet.js` present, no unpkg/openstreetmap references in
`index.html`) and fails with a clear error until the repo carries this
build.

## Run it offline

Open `index.html` in a browser (or serve this directory with any
static server — it needs no server-side code). No network is used:
Leaflet 1.9.4 + leaflet-heat are vendored in `vendor/`.

## Tiles

Default tile mode is **grid** — a lat/lon graticule drawn locally, so
the map works with zero tile files. To use real map tiles offline:

1. Get tiles as a directory laid out `{z}/{x}/{y}.png` (any tile
   downloader that writes that layout works; the directory can live
   anywhere on disk).
2. Set **Tile source** to `Local tile directory` and paste the
   directory path (a path relative to this page, or a `file://` path).
3. The map loads tiles from that directory and nothing else.

A tile URL template (`Tile URL template` mode) is also available for
online tile servers — that mode needs the network, by the user's own
choice.

## GPS

- **None** (default) — no fixes; the map is just there.
- **Simulator (demo)** — the original simulated signals (random fixes
  around the centre), for the listed devices.
- **Device GPS** — `navigator.geolocation.watchPosition`. Works
  offline on device GPS. In shells with no location provider
  (e.g. Lucid's Electron shell) it reports that it is unavailable
  instead of pretending.
- **GPX file** — pick a `.gpx` file; its track points plot as one
  device (`gpx-track`), through the same triangulation/path/heat path
  as live fixes.
- **NMEA file** — pick a `.nmea`/`.txt` file; `$GPGGA` (valid fix)
  and `$GPRMC` (status A) sentences plot as one device
  (`nmea-track`).

## Settings

Centre, zoom, tile source/path, GPS source, simulator devices and
interval, show-paths — all in the panel on the left (standalone), or
in Lucid's Settings / the segment (installed). Standalone settings
persist in `localStorage`; installed, Lucid's settings store is the
source of truth and the page follows it over `postMessage`.

## Files

- `index.html` — the page (local vendor only, no CDN).
- `vendor/` — Leaflet 1.9.4 + leaflet-heat 0.2.0 (BSD-2-Clause,
  header kept in `leaflet.js`) + the Leaflet marker art
  (`images/marker-icon.png`, `marker-icon-2x.png`,
  `marker-shadow.png` — without these the markers exist in
  the DOM but render as broken images).
- `arc/` — the engine: `bus`, `entities`, `simulator`,
  `triangulation`, `map` (settings-driven tiles + grid fallback),
  `sensors`, `webgl_rf` (stub), `room_inference` (stub),
  `gps` (Geolocation + GPX + NMEA), `settings` (settings +
  parent bridge).
- `manifest.json` — plugin metadata + settings schema.

## NCO note

Gary: NCO teaches how to run it all offline. The NCO material
surveyed for this build (#11–15 in the 21-immutables dissection)
gives the *discipline* — local-first, deterministic software, local
persistence, no server for the core — which this engine already
embodies ("runs entirely in browser"). It gives no concrete
offline-map method (no tile packaging, no library vendoring, no
GPS-file ingestion), so the conversion itself is standard
engineering: vendor the libraries, local tiles, file-based GPS.
No NCO definitions or mechanisms are invented here.
