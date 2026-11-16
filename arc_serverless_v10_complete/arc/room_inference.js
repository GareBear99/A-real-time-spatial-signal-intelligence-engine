/**
 * ARC v10 — Offline Worldmap plugin: real room inference.
 *
 * The old file was one line: an alert() saying room inference
 * was a prototype. This is the real thing (plan §2 step 6):
 *
 *   6a — floor-plan zones: the user imports a floor plan as
 *        GeoJSON (one Polygon feature per room, same file-import
 *        pattern as GPX), or a simple {rooms:[...]} JSON, and
 *        each fix is assigned to a room by point-in-polygon.
 *        The geometry (pointInPolygon, boundsFromPolygon,
 *        centroid, inferZone) is ported from the v8.9 bundle
 *        (ARC_Spatial_Intelligence_RG_Fusion_v8_9/app/arc/
 *        app.bundle.js). inferZone is kept verbatim as the
 *        quadrant fallback — including v8's labels.
 *   6b — signal-density clustering: clusterWalls() grids the
 *        space into cells and counts observations per cell, so
 *        walls can be estimated from density gradients. It
 *        returns the density field + hotspots as data the map
 *        can draw — not a finished wall detector.
 *
 * Simplicity (Gary's rule): room import is one file picker,
 * one click — no floor-plan editor, no forms. If no rooms are
 * loaded the plugin says "No floor plan loaded" in plain
 * words and keeps working. This file never calls alert().
 *
 * API (window.WorldmapRooms):
 *   parseFloorPlanGeoJSON(text) → {rooms, errors}
 *     rooms: [{name, polygon: [[lat, lon], ...]}]. Accepts a
 *     GeoJSON FeatureCollection of Polygon features (a `name`
 *     property names the room; GeoJSON coordinates are
 *     [lon, lat] and are converted), or a simple
 *     {rooms:[{name, polygon}]} JSON. Never throws: bad input
 *     comes back as errors, with rooms: [].
 *   assignRoom(point, rooms) → room name or 'Unknown'.
 *     point: {lat, lon} (or {lat, lng}) or [lat, lon].
 *   roomAccuracy(assignments, truth) → {correct, total,
 *     accuracy} for measured walks with known truth.
 *   inferZone(point, structurePolygon) → 'Center-Core' /
 *     'North Zone' / 'South Zone' / 'West Zone' / 'East Zone'
 *     (v8's quadrant fallback; structurePolygon is
 *     {polygon} or a bare [[lat, lon], ...] ring).
 *   clusterWalls(observations, bounds, cellSizeM=2) →
 *     {cells:[{lat, lon, density}], hotspots:[...],
 *      rows, cols, cellSizeM, total, maxDensity} — the
 *     density field; hotspots are the cells at/above
 *     mean + 1 stddev (or the densest cell when that is
 *     empty), sorted by density.
 *   loadFloorPlan(text) → parse + store, same shape as
 *     parseFloorPlanGeoJSON. loadFloorPlanFromFile(file) →
 *     Promise of the same. setRooms(rooms) / getRooms().
 *   runRoomInference() — the old button name, now real: if
 *     rooms are loaded, reports the current device's room in
 *     plain words into #roomStatus (created if missing); if
 *     no rooms, says so plainly there. Returns the message.
 *     Never calls alert().
 */

/* --- geometry, ported from the v8.9 bundle (verbatim) --- */

function roomCentroid(poly) {
  var sum = poly.reduce(function (acc, p) {
    return { lat: acc.lat + p[0], lng: acc.lng + p[1] };
  }, { lat: 0, lng: 0 });
  return { lat: sum.lat / poly.length, lng: sum.lng / poly.length };
}

function roomBoundsFromPolygon(poly) {
  var lats = poly.map(function (p) { return p[0]; });
  var lngs = poly.map(function (p) { return p[1]; });
  return {
    minLat: Math.min.apply(null, lats), maxLat: Math.max.apply(null, lats),
    minLng: Math.min.apply(null, lngs), maxLng: Math.max.apply(null, lngs),
  };
}

/* Ray casting. point: {lat, lng|lon}; polygon: [[lat, lng], ...]. */
function roomPointInPolygon(point, polygon) {
  var x = point.lng, y = point.lat;
  var inside = false;
  for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    var xi = polygon[i][1], yi = polygon[i][0];
    var xj = polygon[j][1], yj = polygon[j][0];
    var intersect = ((yi > y) !== (yj > y))
      && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/* Haversine distance in metres. */
function roomDistanceMeters(a, b) {
  var R = 6371000, tr = Math.PI / 180;
  var dLat = (b.lat - a.lat) * tr, dLng = (b.lng - a.lng) * tr;
  var lat1 = a.lat * tr, lat2 = b.lat * tr;
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/* --- point normalisation --- */

/* Accept {lat, lon}, {lat, lng}, or [lat, lon]. Returns
 * {lat, lng} or null when the point is unusable. */
function normalizeRoomPoint(p) {
  if (!p) return null;
  if (Array.isArray(p) && p.length >= 2
    && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
    return { lat: p[0], lng: p[1] };
  }
  if (typeof p === 'object'
    && Number.isFinite(p.lat)
    && (Number.isFinite(p.lon) || Number.isFinite(p.lng))) {
    return { lat: p.lat, lng: Number.isFinite(p.lon) ? p.lon : p.lng };
  }
  return null;
}

/* A room polygon is [[lat, lon], ...] with at least 3
 * distinct points. Auto-closes an open ring. Returns the
 * cleaned ring or null. */
function cleanRoomPolygon(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return null;
  var ring = [];
  var seen = {};
  polygon.forEach(function (p) {
    var pt = normalizeRoomPoint(p);
    if (!pt) return;
    var key = pt.lat + ',' + pt.lng;
    if (seen[key]) return;
    seen[key] = true;
    ring.push([pt.lat, pt.lng]);
  });
  if (ring.length < 3) return null;
  var first = ring[0], last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}

/* --- floor-plan parsing --- */

/* Parse one GeoJSON Polygon feature's outer ring. GeoJSON
 * coordinates are [lon, lat]; the internal form is
 * [lat, lon]. MultiPolygon takes its first polygon. */
function geoJsonRingToRoom(feature, index, errors) {
  var geom = feature && feature.geometry;
  if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) {
    errors.push('Feature ' + index + ': geometry is not a Polygon, skipped.');
    return null;
  }
  var coords = geom.type === 'Polygon' ? geom.coordinates : geom.coordinates[0];
  if (!Array.isArray(coords) || !coords.length || !Array.isArray(coords[0])) {
    errors.push('Feature ' + index + ': no coordinate ring, skipped.');
    return null;
  }
  var ring = coords[0].map(function (c) {
    return Array.isArray(c) && c.length >= 2 ? [c[1], c[0]] : null;
  });
  var polygon = cleanRoomPolygon(ring);
  if (!polygon) {
    errors.push('Feature ' + index + ': ring has fewer than 3 distinct points, skipped.');
    return null;
  }
  var props = (feature.properties && typeof feature.properties === 'object')
    ? feature.properties : {};
  var name = props.name || props.room || props.label
    || ('Room ' + (index + 1));
  return { name: String(name), polygon: polygon };
}

function parseFloorPlanGeoJSON(text) {
  var errors = [];
  var rooms = [];
  var data = text;
  if (typeof text === 'string') {
    var trimmed = text.trim();
    if (!trimmed) return { rooms: [], errors: ['Empty floor-plan file.'] };
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      return { rooms: [], errors: ['Not valid JSON: ' + (e && e.message ? e.message : e)] };
    }
  }
  if (!data || typeof data !== 'object') {
    return { rooms: [], errors: ['Floor plan must be JSON text or an object.'] };
  }
  /* Simple form: {rooms: [{name, polygon: [[lat, lon], ...]}]} */
  if (Array.isArray(data.rooms)) {
    data.rooms.forEach(function (r, i) {
      if (!r || typeof r !== 'object') {
        errors.push('Room ' + i + ': not an object, skipped.');
        return;
      }
      var polygon = cleanRoomPolygon(r.polygon);
      if (!polygon) {
        errors.push('Room ' + (r.name || i) + ': polygon needs 3+ points, skipped.');
        return;
      }
      rooms.push({ name: String(r.name || ('Room ' + (i + 1))), polygon: polygon });
    });
    return { rooms: rooms, errors: errors };
  }
  /* GeoJSON form: FeatureCollection of Polygon features. */
  if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
    data.features.forEach(function (feature, i) {
      var room = geoJsonRingToRoom(feature, i, errors);
      if (room) rooms.push(room);
    });
    if (!rooms.length && !errors.length) {
      errors.push('FeatureCollection has no features.');
    }
    return { rooms: rooms, errors: errors };
  }
  /* A lone Feature, or a bare array of features. */
  if (data.type === 'Feature') {
    var room = geoJsonRingToRoom(data, 0, errors);
    if (room) rooms.push(room);
    return { rooms: rooms, errors: errors };
  }
  if (Array.isArray(data.features)) {
    return { rooms: [], errors: ['Expected a FeatureCollection.'] };
  }
  return {
    rooms: [],
    errors: ['Unrecognised floor-plan format: expected a GeoJSON FeatureCollection of Polygons or {rooms:[...]}.'],
  };
}

/* --- assignment + measurement --- */

function assignRoom(point, rooms) {
  var p = normalizeRoomPoint(point);
  if (!p || !Array.isArray(rooms)) return 'Unknown';
  for (var i = 0; i < rooms.length; i++) {
    var room = rooms[i];
    if (room && Array.isArray(room.polygon)
      && roomPointInPolygon(p, room.polygon)) {
      return room.name || 'Unknown';
    }
  }
  return 'Unknown';
}

/* assignments/truth: arrays of room names, same order, one
 * entry per fix of a measured walk. */
function roomAccuracy(assignments, truth) {
  var a = Array.isArray(assignments) ? assignments : [];
  var t = Array.isArray(truth) ? truth : [];
  var total = t.length;
  var correct = 0;
  for (var i = 0; i < total; i++) {
    if (a[i] !== undefined && a[i] === t[i]) correct++;
  }
  return {
    correct: correct,
    total: total,
    accuracy: total ? correct / total : 0,
  };
}

/* --- inferZone: v8's quadrant fallback, ported verbatim ---
 * NOTE: v8's labels are flipped against geography — a point
 * near minLat (the southern edge) is called 'North Zone' and
 * near maxLat 'South Zone'. That is v8's behaviour, kept
 * exactly so fixtures written against v8 still match. Do not
 * "fix" the labels here; fix them in v8 first if ever. */
function inferZone(point, structurePolygon) {
  var p = normalizeRoomPoint(point);
  if (!p) return 'Unknown';
  var polygon = null;
  if (structurePolygon && Array.isArray(structurePolygon.polygon)) {
    polygon = structurePolygon.polygon;
  } else if (Array.isArray(structurePolygon)) {
    polygon = structurePolygon;
  }
  if (!polygon || polygon.length < 3) return 'Unknown';
  var b = roomBoundsFromPolygon(polygon);
  var rx = (p.lng - b.minLng) / ((b.maxLng - b.minLng) || 1);
  var ry = (p.lat - b.minLat) / ((b.maxLat - b.minLat) || 1);
  if (Math.abs(rx - 0.5) < 0.18 && Math.abs(ry - 0.5) < 0.18) return 'Center-Core';
  if (ry < 0.33) return 'North Zone';
  if (ry > 0.66) return 'South Zone';
  return rx < 0.5 ? 'West Zone' : 'East Zone';
}

/* --- signal-density clustering (step 6b) ---
 * Grids the space into cellSizeM squares, counts observations
 * per cell, and returns the density field plus its hotspots.
 * A wall shows up as a sharp density gradient between
 * neighbouring cells; this function returns the field so the
 * map can draw it — it is not a wall detector by itself. */
function clusterWalls(observations, bounds, cellSizeM) {
  var cellM = Number.isFinite(cellSizeM) && cellSizeM > 0 ? cellSizeM : 2;
  var empty = { cells: [], hotspots: [], rows: 0, cols: 0, cellSizeM: cellM, total: 0, maxDensity: 0 };
  if (!bounds || typeof bounds !== 'object') return empty;
  var minLat = bounds.minLat, maxLat = bounds.maxLat;
  var minLon = Number.isFinite(bounds.minLon) ? bounds.minLon : bounds.minLng;
  var maxLon = Number.isFinite(bounds.maxLon) ? bounds.maxLon : bounds.maxLng;
  if (!Number.isFinite(minLat) || !Number.isFinite(maxLat)
    || !Number.isFinite(minLon) || !Number.isFinite(maxLon)
    || maxLat <= minLat || maxLon <= minLon) {
    return empty;
  }
  var meanLat = (minLat + maxLat) / 2;
  var dLat = cellM / 111320;
  var dLon = cellM / (111320 * Math.cos(meanLat * Math.PI / 180));
  var rows = Math.min(200, Math.max(1, Math.ceil((maxLat - minLat) / dLat)));
  var cols = Math.min(200, Math.max(1, Math.ceil((maxLon - minLon) / dLon)));
  var counts = {};
  var total = 0;
  (Array.isArray(observations) ? observations : []).forEach(function (o) {
    var p = normalizeRoomPoint(o);
    if (!p) return;
    if (p.lat < minLat || p.lat > maxLat || p.lng < minLon || p.lng > maxLon) return;
    var r = Math.min(rows - 1, Math.floor((p.lat - minLat) / dLat));
    var c = Math.min(cols - 1, Math.floor((p.lng - minLon) / dLon));
    var key = r + ',' + c;
    counts[key] = (counts[key] || 0) + 1;
    total++;
  });
  var cells = Object.keys(counts).map(function (key) {
    var parts = key.split(',');
    var r = parseInt(parts[0], 10), c = parseInt(parts[1], 10);
    return {
      lat: minLat + (r + 0.5) * dLat,
      lon: minLon + (c + 0.5) * dLon,
      density: counts[key],
    };
  });
  cells.sort(function (a, b) { return b.density - a.density; });
  var maxDensity = cells.length ? cells[0].density : 0;
  var hotspots = [];
  if (cells.length) {
    var mean = total / cells.length;
    var variance = cells.reduce(function (acc, cell) {
      return acc + (cell.density - mean) * (cell.density - mean);
    }, 0) / cells.length;
    var threshold = mean + Math.sqrt(variance);
    hotspots = cells.filter(function (cell) { return cell.density >= threshold; });
    if (!hotspots.length) hotspots = [cells[0]];
    hotspots.sort(function (a, b) { return b.density - a.density; });
  }
  return {
    cells: cells,
    hotspots: hotspots,
    rows: rows,
    cols: cols,
    cellSizeM: cellM,
    total: total,
    maxDensity: maxDensity,
  };
}

/* --- loaded rooms + the button --- */

var loadedRooms = [];

function setRooms(rooms) {
  loadedRooms = (Array.isArray(rooms) ? rooms : [])
    .map(function (r) {
      if (!r || typeof r !== 'object') return null;
      var polygon = cleanRoomPolygon(r.polygon);
      if (!polygon) return null;
      return { name: String(r.name || 'Room'), polygon: polygon };
    })
    .filter(Boolean);
  return loadedRooms.length;
}

function getRooms() {
  return loadedRooms.map(function (r) {
    return { name: r.name, polygon: r.polygon.map(function (p) { return [p[0], p[1]]; }) };
  });
}

function loadFloorPlan(text) {
  var result = parseFloorPlanGeoJSON(text);
  if (result.rooms.length) setRooms(result.rooms);
  return result;
}

function loadFloorPlanFromFile(file) {
  if (!file || typeof file.text !== 'function') {
    return Promise.resolve({ rooms: [], errors: ['No file, or the file cannot be read as text.'] });
  }
  return file.text().then(function (text) { return loadFloorPlan(text); });
}

/* The current device position: the last triangulated location
 * of the first device that has one, from the plugin's device
 * graph (entities.js) or the __worldmap debug hook. */
function currentDevicePosition() {
  var g = null;
  if (typeof window !== 'undefined' && window.__worldmap && window.__worldmap.graph) {
    g = window.__worldmap.graph;
  } else if (typeof graph !== 'undefined' && graph && graph.devices) {
    /* The plugin's device graph (entities.js). The bare name
     * reads the global lexical binding; this local is named
     * `g` precisely so it does not shadow it. */
    g = graph;
  }
  if (!g || !g.devices) return null;
  var ids = Object.keys(g.devices);
  for (var i = 0; i < ids.length; i++) {
    var d = g.devices[ids[i]];
    if (d && Array.isArray(d.locations) && d.locations.length) {
      var loc = d.locations[d.locations.length - 1];
      if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
        return { lat: loc.lat, lon: loc.lon };
      }
    }
  }
  return null;
}

function roomStatusElement() {
  if (typeof document === 'undefined') return null;
  var el = document.getElementById('roomStatus');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'roomStatus';
  el.style.cssText = 'font-size:11px;margin-top:4px;min-height:14px';
  var ui = document.getElementById('ui');
  if (ui) ui.appendChild(el);
  else if (document.body) document.body.appendChild(el);
  return el;
}

/* The old button name, now real. Reports in plain words into
 * #roomStatus (created if missing) and returns the message.
 * Never calls alert(). */
function runRoomInference() {
  var msg;
  var rooms = getRooms();
  if (!rooms.length) {
    msg = 'No floor plan loaded — import a GeoJSON floor plan to name rooms.';
  } else {
    var pos = currentDevicePosition();
    if (!pos) {
      msg = 'Floor plan loaded (' + rooms.length + ' room'
        + (rooms.length === 1 ? '' : 's')
        + ') — no device position yet.';
    } else {
      var room = assignRoom(pos, rooms);
      msg = room === 'Unknown'
        ? 'Device is outside all rooms (Unknown).'
        : 'Device is in: ' + room;
    }
  }
  var el = roomStatusElement();
  if (el) el.textContent = msg;
  return msg;
}

if (typeof window !== 'undefined') {
  window.WorldmapRooms = {
    parseFloorPlanGeoJSON: parseFloorPlanGeoJSON,
    assignRoom: assignRoom,
    roomAccuracy: roomAccuracy,
    inferZone: inferZone,
    clusterWalls: clusterWalls,
    loadFloorPlan: loadFloorPlan,
    loadFloorPlanFromFile: loadFloorPlanFromFile,
    setRooms: setRooms,
    getRooms: getRooms,
    runRoomInference: runRoomInference,
    pointInPolygon: roomPointInPolygon,
    boundsFromPolygon: roomBoundsFromPolygon,
    centroid: roomCentroid,
    distanceMeters: roomDistanceMeters,
  };
  /* Global for the existing button in index.html. */
  window.runRoomInference = runRoomInference;
}
