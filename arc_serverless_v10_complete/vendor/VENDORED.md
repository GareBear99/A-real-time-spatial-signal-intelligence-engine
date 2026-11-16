# Vendored files

Everything in `plugin/vendor/` is a build-time copy of a third-party
library, so the plugin runs with zero network at runtime. Nothing
here is fetched at runtime.

## sql.js 1.13.0 (MIT)

- Files: `sql-wasm.js`, `sql-wasm.wasm`
- Source: https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/sql-wasm.js
  and `.../sql-wasm.wasm` (downloaded 2026-11-15, build time only)
- Version confirmed against the package metadata
  (`https://cdn.jsdelivr.net/npm/sql.js@1.13.0/package.json`:
  version `1.13.0`, license `MIT`).
- SHA-256:
  - `sql-wasm.js`: `694ca5b36aa3e6e71f417819d7df390b65343665fcfa5c69015ca33d93d291b3`
  - `sql-wasm.wasm`: `0734155c83e493983d1f2ff5b09a4fab6e35a32e9449c7e4e545756439f62d73`
- What it is: SQLite compiled to WebAssembly. Used by
  `arc/tiles.js` to open MBTiles (SQLite) packs in the browser.
  Loaded with `locateFile` pointing at `./vendor/sql-wasm.wasm`
  (relative to the plugin page), so no network is involved.
- License: MIT (see the sql.js project).

## Leaflet.TileLayer.MBTiles — minimal equivalent, written here (MIT)

- File: `Leaflet.TileLayer.MBTiles.js`
- Source: written for this plugin 2026-11-15 — NOT a copy.
  The upstream it was modelled on
  (`timwis/Leaflet.TileLayer.MBTiles`,
  `https://raw.githubusercontent.com/timwis/Leaflet.TileLayer.MBTiles/master/Leaflet.TileLayer.MBTiles.js`)
  was tried first and is no longer fetchable: both that URL and
  the GitHub API for the repo return 404 as of 2026-11-15, so
  there was nothing to vendor.
- What it is: an `L.GridLayer` subclass that serves tiles from
  an already-open sql.js database (opened by `arc/tiles.js`
  from a user-picked `.mbtiles` file). One query:
  `SELECT tile_data FROM tiles WHERE zoom_level=? AND
  tile_column=? AND tile_row=?`, with the MBTiles TMS row flip
  (`tile_row = (2^z - 1) - y`). Missing tiles render as a
  transparent 1×1 pixel, never an error.
- Difference from the upstream: the upstream took a tile-pack
  URL and fetched it itself; this one takes an open db, because
  the plugin's flow is file-pick (the file is opened once by
  `arc/tiles.js` and handed to the layer). No network either way.

## Leaflet 1.9.4 + leaflet-heat 0.2.0 (pre-existing)

Vendored earlier by the offline conversion (see `notes.md`):
`leaflet.js`, `leaflet.css`, `leaflet-heat.js`, `images/` (marker
art). Unchanged by this step.
