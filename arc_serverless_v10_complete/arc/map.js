
/**
 * ARC v10 — Offline Worldmap plugin: map.
 *
 * Adapted from the original arc/map.js (base: the zip Gary
 * gave us — the original hard-coded an OpenStreetMap tile
 * layer, which needs the network). The tile source is now
 * settings-driven (see arc/settings.js):
 *
 *   'grid'  — default. No tiles: a lat/lon graticule layer
 *             is drawn instead, so the map works with zero
 *             tile files and zero network.
 *   'local' — a tile directory the user points at, laid out
 *             as {z}/{x}/{y}.png (a file:// path or a path
 *             relative to this page). A full {z}/{x}/{y}
 *             template is also accepted.
 *   'url'   — a tile URL template the user pastes in (online
 *             only, the user's own choice — never a default).
 *
 * Markers, path polylines, heat and stats are unchanged
 * from the original: every fix — simulated or real GPS —
 * flows through the same bus and lands here.
 */

let map, heat, markers = [], showPath = true;
let tileLayer = null;
let roomLayers = [];

/** A tile that draws the lat/lon graticule on canvas — the
 *  no-tile fallback. Lines every 1° / 0.1° / 0.01° depending
 *  on zoom, with coordinate labels at the tile edges. */
const GridTileLayer = L.GridLayer.extend({
  createTile(coords) {
    const tile = document.createElement('canvas');
    tile.width = 256;
    tile.height = 256;
    const ctx = tile.getContext('2d');
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, 256, 256);
    const bounds = this._tileCoordsToBounds(coords);
    const west = bounds.getWest();
    const east = bounds.getEast();
    const north = bounds.getNorth();
    const south = bounds.getSouth();
    const zoom = coords.z;
    const step = zoom >= 15 ? 0.01 : zoom >= 12 ? 0.1 : 1;
    const lonToX = (lon) => ((lon - west) / (east - west)) * 256;
    const latToY = (lat) => ((north - lat) / (north - south)) * 256;
    ctx.strokeStyle = 'rgba(0, 255, 0, 0.18)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(0, 255, 0, 0.55)';
    ctx.font = '10px monospace';
    for (let lon = Math.ceil(west / step) * step; lon <= east; lon += step) {
      const x = lonToX(lon);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 256);
      ctx.stroke();
      ctx.fillText(lon.toFixed(2), x + 2, 12);
    }
    for (let lat = Math.ceil(south / step) * step; lat <= north; lat += step) {
      const y = latToY(lat);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(256, y);
      ctx.stroke();
      ctx.fillText(lat.toFixed(2), 2, y - 2);
    }
    return tile;
  },
});

/** Build the tile layer for the current settings. Returns
 *  null when the mode has no layer (never for 'grid'). */
function buildTileLayer(settings) {
  const mode = (settings && settings.tileMode) || 'grid';
  if (mode === 'mbtiles') {
    // A real offline tile pack (single .mbtiles file, opened
    // with vendored sql.js). No pack open yet -> the grid,
    // so the map still works; the page says to pick a file.
    if (typeof WorldmapTiles !== 'undefined' && WorldmapTiles.createMbtilesLayer) {
      try {
        return WorldmapTiles.createMbtilesLayer();
      } catch (e) {
        return new GridTileLayer();
      }
    }
    return new GridTileLayer();
  }
  if (mode === 'local') {
    const raw = ((settings && settings.tilePath) || '').trim();
    if (!raw) return new GridTileLayer();
    const template = raw.indexOf('{z}') !== -1
      ? raw
      : raw.replace(/\/+$/, '') + '/{z}/{x}/{y}.png';
    return L.tileLayer(template, { maxZoom: 19 });
  }
  if (mode === 'url') {
    const template = ((settings && settings.tileUrlTemplate) || '').trim();
    if (!template) return new GridTileLayer();
    return L.tileLayer(template, { maxZoom: 19 });
  }
  return new GridTileLayer();
}

/** Swap the tile layer without touching markers/paths/heat. */
function setTileLayer(settings) {
  if (!map) return;
  const next = buildTileLayer(settings);
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = next;
  tileLayer.addTo(map);
}

function initMap(settings) {
  const s = settings || {};
  const lat = typeof s.centerLat === 'number' ? s.centerLat : 52.131;
  const lon = typeof s.centerLon === 'number' ? s.centerLon : -122.141;
  const zoom = typeof s.zoom === 'number' ? s.zoom : 15;
  showPath = s.showPaths !== false;
  map = L.map('map').setView([lat, lon], zoom);
  tileLayer = buildTileLayer(s);
  tileLayer.addTo(map);
  heat = L.heatLayer([], { radius: 25 }).addTo(map);
}

function togglePath() { showPath = !showPath; }

/** Draw the loaded floor-plan rooms as polygons with their
 *  names. No rooms loaded -> nothing drawn. Safe without L. */
function renderRoomsOnMap() {
  roomLayers.forEach((layer) => {
    try {
      map.removeLayer(layer);
    } catch (e) {
      // Best effort.
    }
  });
  roomLayers = [];
  if (!map || typeof L === 'undefined' || !L.polygon) return 0;
  if (typeof WorldmapRooms === 'undefined' || !WorldmapRooms.getRooms) return 0;
  let rooms = [];
  try {
    rooms = WorldmapRooms.getRooms() || [];
  } catch (e) {
    return 0;
  }
  rooms.forEach((room) => {
    if (!room || !Array.isArray(room.polygon) || room.polygon.length < 3) return;
    try {
      const pts = room.polygon.map((p) => (Array.isArray(p) ? [p[0], p[1]] : [p.lat, p.lon]));
      const layer = L.polygon(pts, { color: '#66ccff', weight: 2, fillOpacity: 0.08 }).addTo(map);
      if (room.name) layer.bindTooltip(room.name, { permanent: true, direction: 'center', className: 'room-label' });
      roomLayers.push(layer);
    } catch (e) {
      // A room that cannot draw is skipped, not fatal.
    }
  });
  return roomLayers.length;
}

function updateMap() {
  markers.forEach(m => map.removeLayer(m));
  markers = [];
  const heatPts = [];

  renderRoomsOnMap();

  Object.values(graph.devices).forEach(d => {
    const loc = d.locations.at(-1);
    if (!loc) return;

    const m = L.marker([loc.lat, loc.lon]).addTo(map);
    markers.push(m);

    if (showPath && d.path.length > 1) {
      const pts = d.path.map(p => [p.lat, p.lon]);
      L.polyline(pts, { color: "cyan" }).addTo(map);
    }

    heatPts.push([loc.lat, loc.lon, 0.8]);
  });

  heat.setLatLngs(heatPts);

  const last = Object.values(graph.devices).map(d => d.locations.at(-1)).filter(Boolean).pop();
  const roomText = last && typeof WorldmapRooms !== 'undefined' && WorldmapRooms.getRooms
    ? (function () {
        try {
          const rooms = WorldmapRooms.getRooms() || [];
          if (!rooms.length) return '';
          const name = WorldmapRooms.assignRoom(last, rooms);
          return name && name !== 'Unknown' ? ' · ' + name : '';
        } catch (e) {
          return '';
        }
      })()
    : '';
  document.getElementById("stats").innerText =
    "devices:" + Object.keys(graph.devices).length + roomText;
}
