# pack-tiles — the real offline tile pack step

One-time, offline pack generation (step 7c of the SOTA-offline
plan). The plugin renders real map imagery offline from an
MBTiles pack; the pack is built once, on the VM or the Mac,
never downloaded at runtime.

## The real pack step

1. **Get an extract.** Download a Geofabrik `.osm.pbf` extract
   for the region: https://download.geofabrik.de — pick the
   smallest region that covers the area (a city or county
   extract, not a country). For Williams Lake that is the
   British Columbia extract, clipped, or a smaller extract if
   one covers it.
2. **Get Planetiler.** One-time: `./pack-tiles.sh --fetch-planetiler`
   (downloads `planetiler.jar` from the Planetiler GitHub
   releases), or place `planetiler.jar` next to the script, or
   set `PLANETILER_JAR`.
3. **Build the pack.**
   `./pack-tiles.sh <region.osm.pbf> [output.mbtiles]`
   which runs:
   `java -Xmx4g -jar planetiler.jar --area=<region.osm.pbf> --output=<area>.mbtiles`
4. **Use it.** In the plugin, pick the `.mbtiles` file —
   `arc/tiles.js` `openMbtilesFile` opens it with the vendored
   sql.js and `createMbtilesLayer` serves it through the
   vendored `Leaflet.TileLayer.MBTiles` layer. The `grid`
   graticule stays as the zero-file fallback; `local` mode
   (a `{z}/{x}/{y}.png` directory) is the loose-tile
   alternative — see `arc/tiles.js` `localTileTemplate`.

## Requirements / status in this VM

- **Java is NOT installed in this VM** (`java: command not
  found`, checked 2026-11-15), so the Planetiler step could
  not be run here and no Geofabrik extract was downloaded
  (a real region extract is hundreds of MB). The script
  checks for java and fails with a clear message when it is
  missing. Run the pack step on a machine with Java 17+,
  or install a JRE in the VM first.
- **A real MBTiles pack WAS built here, by the pragmatic
  route:** `proof/tiles-test.mbtiles` — 162 real tiles
  (z14–15, 9×9 around Williams Lake 52.131, -122.141, so the
  whole 1280×900 viewport at z15 is covered),
  generated as PNGs with Python PIL (`proof/tiles-test/`),
  packed into a spec-conformant MBTiles SQLite file with
  Python `sqlite3` (metadata + tiles tables, TMS-flipped
  `tile_row`), 774,144 bytes. It is a test fixture, NOT real
  map imagery — the tile labels say so — but it is a real
  `.mbtiles` file: `openMbtilesFile` / `getTileBlob` /
  `createMbtilesLayer` all read it back (proven by the unit
  tests and the Electron check, `proof/check-local-tiles.js`).
- **Sizes (from the plan):** MBTiles runs ~50–60% smaller
  than the same tiles as loose PNGs (~900 MB vs ~2 GB for a
  500 km² region at z13–z16). A city region at street zooms
  is hundreds of MB — budget storage accordingly.

## Files

- `scripts/pack-tiles.sh` — the pack script (usage text built in).
- `proof/tiles-test/` — generated PNG fixture tiles.
- `proof/tiles-test.mbtiles` — fixture MBTiles pack built from them.
