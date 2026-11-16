#!/bin/bash
# pack-tiles.sh — build an offline MBTiles pack from an OSM extract.
#
# One-time, offline pack generation (step 7c of the SOTA-offline
# plan). Takes a Geofabrik .osm.pbf extract for the region and
# runs Planetiler to generate an MBTiles pack the plugin can
# open with zero network at runtime (arc/tiles.js +
# vendor/Leaflet.TileLayer.MBTiles.js).
#
# Usage:
#   ./pack-tiles.sh <region.osm.pbf> [output.mbtiles]
#   ./pack-tiles.sh --fetch-planetiler   # download planetiler.jar once, then exit
#
# Defaults: output is <region>.mbtiles next to the input.
# Needs: java (17+ for current Planetiler) and planetiler.jar.
# The jar is NOT downloaded automatically — run with
# --fetch-planetiler once, or place planetiler.jar next to this
# script, or set PLANETILER_JAR to its path.
#
# Get the extract from Geofabrik (https://download.geofabrik.de)
# — pick the smallest region that covers the area, e.g. a city
# or county extract. A city region at street zooms (z13–z16)
# is hundreds of MB as MBTiles; the pack is built once, on the
# VM or the Mac, and shipped with / beside the plugin — never
# downloaded at runtime.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
JAR="${PLANETILER_JAR:-$DIR/planetiler.jar}"
PLANETILER_RELEASE_URL="https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar"

usage() {
  cat <<'EOF'
Usage: pack-tiles.sh <region.osm.pbf> [output.mbtiles]
       pack-tiles.sh --fetch-planetiler

Build an offline MBTiles pack from a Geofabrik .osm.pbf extract
using Planetiler. Example:

  ./pack-tiles.sh williams-lake.osm.pbf williams-lake.mbtiles

Requirements: java 17+ and planetiler.jar (next to this script,
or PLANETILER_JAR=/path/to/planetiler.jar). Get the jar once with:

  ./pack-tiles.sh --fetch-planetiler

Get extracts at https://download.geofabrik.de — smallest region
that covers the area. The pack is built once and used offline;
nothing is downloaded at runtime.
EOF
}

if [ "${1:-}" = "--fetch-planetiler" ]; then
  if [ -f "$JAR" ]; then
    echo "planetiler.jar already present: $JAR"
    exit 0
  fi
  echo "Downloading Planetiler jar (one-time, build-time only)..."
  curl -fL -o "$JAR" "$PLANETILER_RELEASE_URL"
  echo "Saved: $JAR"
  java -jar "$JAR" --help >/dev/null 2>&1 || true
  exit 0
fi

if [ $# -lt 1 ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 1
fi

PBF="$1"
OUT="${2:-${PBF%.osm.pbf}.mbtiles}"

if ! command -v java >/dev/null 2>&1; then
  echo "ERROR: java not found. Planetiler needs Java 17+." >&2
  echo "Install a JRE (e.g. Temurin 17+) and re-run." >&2
  exit 1
fi
if [ ! -f "$JAR" ]; then
  echo "ERROR: planetiler.jar not found at $JAR" >&2
  echo "Run: $0 --fetch-planetiler" >&2
  echo "  or set PLANETILER_JAR=/path/to/planetiler.jar" >&2
  exit 1
fi
if [ ! -f "$PBF" ]; then
  echo "ERROR: extract not found: $PBF" >&2
  echo "Download a Geofabrik .osm.pbf extract: https://download.geofabrik.de" >&2
  exit 1
fi

echo "Input:  $PBF"
echo "Output: $OUT"
echo "Jar:    $JAR"
java -Xmx4g -jar "$JAR" --area="$PBF" --output="$OUT"
echo "Done: $OUT ($(du -h "$OUT" | cut -f1))"
echo "Open it in the plugin: pick the .mbtiles file (tiles.js openMbtilesFile)."
