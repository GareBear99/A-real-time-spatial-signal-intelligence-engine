
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
 * flows through the same bus and lands here. The continuum
 * segment (arc/continuum.js) also draws here: seeded structure
 * polygons, perimeter geofences, the track-density heat grid,
 * candidate clouds, and attached blueprint images.
 */

let map, heat, markers = [], showPath = true;
let tileLayer = null;
let roomLayers = [];
let continuumLayers = [];

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

/** Draw the continuum segment (ARC-Core's geospatial surface)
 *  on the map: seeded structure polygons, perimeter geofences,
 *  the per-structure track-density heat grid (when enabled),
 *  the ARC-Core candidate cloud around the latest fix, and any
 *  blueprint image the user attached. No structures shown when
 *  the continuum layer is off (settings showContinuum) or the
 *  module is not loaded. Safe without L. Returns the layer
 *  count drawn. */
function renderContinuumOnMap() {
  continuumLayers.forEach((layer) => {
    try {
      map.removeLayer(layer);
    } catch (e) {
      // Best effort.
    }
  });
  continuumLayers = [];
  if (!map || typeof L === 'undefined' || !L.polygon) return 0;
  if (typeof worldmapShowContinuum !== 'undefined' && worldmapShowContinuum === false) return 0;
  if (typeof WorldmapContinuum === 'undefined') return 0;
  const add = (layer) => {
    if (!layer) return;
    continuumLayers.push(layer);
  };
  const structures = WorldmapContinuum.CONTINUUM_STRUCTURES || [];
  structures.forEach((s) => {
    if (!Array.isArray(s.polygon) || s.polygon.length < 3) return;
    try {
      // ARC-Core geo console colour for structure outlines.
      const layer = L.polygon(s.polygon, { color: '#c8b7ff', weight: 2, fillOpacity: 0.08 }).addTo(map);
      layer.bindTooltip(s.name, { permanent: true, direction: 'center', className: 'room-label' });
      add(layer);
    } catch (e) {
      // A structure that cannot draw is skipped, not fatal.
    }
  });
  (WorldmapContinuum.CONTINUUM_GEOFENCES || []).forEach((g) => {
    if (!Array.isArray(g.polygon) || g.polygon.length < 3) return;
    try {
      const color = g.severity >= 7 ? '#ff7f97' : g.severity >= 5 ? '#ffb454' : '#54d39b';
      const layer = L.polygon(g.polygon, { color, weight: 2, dashArray: '6 4', fillOpacity: 0.04 }).addTo(map);
      layer.bindTooltip(g.name + ' · severity ' + g.severity, { direction: 'top', className: 'room-label' });
      add(layer);
    } catch (e) {
      // Best effort.
    }
  });
  // Blueprint overlays with a locally attached image: drawn at
  // the structure bounds with the stored opacity. Leaflet's
  // image overlay has no rotation, so rotation_deg / scale /
  // offset are stored on the record (ARC-Core shape) but only
  // opacity + bounds render — stated, not silently faked.
  try {
    WorldmapContinuum.listBlueprintOverlays().forEach((b) => {
      if (!b.image_url) return;
      const s = WorldmapContinuum.structureById(b.structure_id);
      if (!s || !L.imageOverlay) return;
      const bounds = WorldmapGeo.boundsFromPolygon(s.polygon);
      const layer = L.imageOverlay(
        b.image_url,
        [[bounds.minLat, bounds.minLon], [bounds.maxLat, bounds.maxLon]],
        { opacity: b.opacity, interactive: false },
      ).addTo(map);
      add(layer);
    });
  } catch (e) {
    // Best effort.
  }
  // Track-density heat grid (ARC-Core get_heatmap) per structure.
  if (typeof worldmapShowContinuumHeat !== 'undefined' && worldmapShowContinuumHeat === true) {
    try {
      const tracks = [];
      if (typeof graph !== 'undefined' && graph && graph.devices) {
        Object.values(graph.devices).forEach((d) => {
          (d.locations || []).forEach((loc) => tracks.push(loc));
        });
      }
      structures.forEach((s) => {
        const grid = WorldmapContinuum.continuumHeatmap(s, tracks, 8);
        grid.cells.forEach((cell) => {
          if (!cell.count) return;
          const b = WorldmapGeo.boundsFromPolygon(s.polygon);
          const latStep = (b.maxLat - b.minLat) / grid.grid_size;
          const lonStep = (b.maxLon - b.minLon) / grid.grid_size;
          const cellBounds = [
            [b.minLat + cell.gy * latStep, b.minLon + cell.gx * lonStep],
            [b.minLat + (cell.gy + 1) * latStep, b.minLon + (cell.gx + 1) * lonStep],
          ];
          const alpha = Math.min(0.78, 0.1 + cell.count * 0.14);
          add(L.rectangle(cellBounds, { color: '#9a71ff', weight: 0, fillOpacity: alpha }).addTo(map));
        });
      });
    } catch (e) {
      // Best effort.
    }
  }
  // ARC-Core candidate cloud around each device's latest fix,
  // when the fix sits inside a structure.
  try {
    if (typeof graph !== 'undefined' && graph && graph.devices) {
      Object.values(graph.devices).forEach((d) => {
        const last = (d.locations || []).at(-1);
        if (!last) return;
        const s = WorldmapContinuum.structureContaining(last);
        if (!s) return;
        WorldmapContinuum.arcCandidateCloud(s, last, last.confidence, 16).forEach((p) => {
          if (typeof L.circleMarker === 'function') {
            add(L.circleMarker([p.lat, p.lon], { radius: 2, color: '#54d39b', weight: 1, fillOpacity: 0.6 }).addTo(map));
          }
        });
      });
    }
  } catch (e) {
    // Best effort.
  }
  return continuumLayers.length;
}

function updateMap() {
  markers.forEach(m => map.removeLayer(m));
  markers = [];
  const heatPts = [];

  renderRoomsOnMap();
  renderContinuumOnMap();

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
  if (typeof updateContinuumUI === 'function') {
    try {
      updateContinuumUI();
    } catch (e) {
      // The continuum panel is optional.
    }
  }
}
