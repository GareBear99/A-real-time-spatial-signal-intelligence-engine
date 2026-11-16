# ARC v10 Offline Worldmap

ARC v10 Serverless Spatial Engine as an **offline world map plugin** —
multi-device tracking, real RF propagation visualization, real
sensors, least-squares multilateration, Kalman-filtered tracks,
room inference from floor plans, offline tile packs, and an
Accuracy Lab that measures the error in metres. Runs entirely in
the browser with **zero network**.

## What is real now (SOTA build, 2026-11-15)

- **Location** comes from least-squares multilateration over
  RSSI-derived distances (log-distance path loss), smoothed by a
  Kalman filter — not a centroid average. Baseline on the seeded
  test track: **5.89 m RMSE** (weighted average: 7.33 m).
  "How accurate is this?" runs the lab and says so in plain words.
- **Sensors** are placed (click the map, import a file, or place
  them for me) — never random. They persist, and a flaky one
  counts for less.
- **RF rings** are drawn from real sensor positions and real
  signal strength. **Rooms** come from a GeoJSON floor plan you
  import. **Tiles** can be a real offline pack (`.mbtiles` file)
  or a local tile folder — the grid is the zero-file fallback.
- **Signal scans** (CSV, JSON, or macOS `airport -s` output)
  import as a file and triangulate like live signals.
- **Simulator** output is always labelled SIMULATED. Nothing
  fake is presented as real.
- No neural model, no LLM, no GGUF, no training anywhere — the
  model is path loss, geometry, and filtering, in plain
  JavaScript, offline.

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

- **Map file (.mbtiles)** — pick a `.mbtiles` pack (single file,
  read with vendored sql.js). Build one with
  `scripts/pack-tiles.sh` (Geofabrik extract + Planetiler, needs
  Java 17+). The pack is remembered by name; pick it again next
  session (a file can't persist itself).
- **Local tile folder** — a directory laid out `{z}/{x}/{y}.png`
  (any tile downloader that writes that layout works; the directory
  can live anywhere on disk). Set **Map picture** to `Local tile
  folder` and paste the directory path (a path relative to this
  page, or a `file://` path).
- The map loads tiles from that directory/file and nothing else.

A tile URL template (`Web address` mode) is also available for
online tile servers — that mode needs the network, by the user's own
choice.

## GPS

- **Nothing yet** (default) — no fixes; the map is just there.
- **Demo signals (simulated)** — seeded signals from a truth path
  through the path-loss model, for the listed devices. Always
  labelled SIMULATED.
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

## Sensors, rooms, scans

- **Sensors** — click "Add a sensor" then click the map, or
  "Place sensors for me" (seeded inside the default structure),
  or import a JSON/CSV file of `{id, lat, lon, floor}` rows.
- **Floor plan** — pick a GeoJSON file (FeatureCollection of
  Polygons, one per room, with a `name`). "What room is this?"
  names the room the latest fix is in.
- **Signal scan** — pick a CSV/JSON file of `{sensor, rssi,
  time}` rows, or a macOS `airport -s` scan. Readings feed the
  estimator exactly like live signals.
- **How accurate is this?** — runs the Accuracy Lab (seeded
  Monte Carlo, 120 frames) and reports the error in metres.
- **Calibrate** — tunes the signal setting from the fixes seen
  so far. **Save my data** — exports every location with the
  observations, calibration, confidence and error behind it.

## Settings

Centre, zoom, map picture, GPS source, demo devices and interval,
how positions are worked out (best fit / weighted average), smooth
the track, surveyed map, signal setting, show-paths — plain words
first in the panel, the rest behind "More settings" (standalone),
or in Lucid's Settings / the segment (installed). Standalone
settings persist in `localStorage`; installed, Lucid's settings
store is the source of truth and the page follows it over
`postMessage`.

## Files

- `index.html` — the page (local vendor only, no CDN).
- `vendor/` — Leaflet 1.9.4 + leaflet-heat 0.2.0 (BSD-2-Clause,
  header kept in `leaflet.js`) + the Leaflet marker art
  (`images/marker-icon.png`, `marker-icon-2x.png`,
  `marker-shadow.png` — without these the markers exist in
  the DOM but render as broken images) + sql.js 1.13.0 (MIT)
  for MBTiles + a small MBTiles Leaflet layer (written here —
  the upstream plugin is gone).
- `arc/` — the engine: `bus`, `entities`, `geo`, `pathloss`,
  `estimator` (weighted + multilateration), `filter` (Kalman +
  particle), `lab` (Accuracy Lab + calibration wizard),
  `evidence`, `simulator` (seeded truth + forward model),
  `triangulation` (bus handler: GPS fixes + sensor observations),
  `map` (settings-driven tiles + grid fallback + rooms),
  `sensors` (placed/persisted), `rf_canvas` (real RF rings),
  `room_inference` (GeoJSON floor plans + density clustering),
  `fingerprint` (kNN radio map, optional), `tiles` (MBTiles +
  local tiles), `rfimport` (scan files),
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
