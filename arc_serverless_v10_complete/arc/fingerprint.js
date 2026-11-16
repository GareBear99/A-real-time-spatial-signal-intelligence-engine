/**
 * ARC v10 — Offline Worldmap plugin: fingerprinting (step 9).
 *
 * Optional mode, off by default. Walk the space once with a
 * recorder, sampling RSSI at known positions, and store the
 * result as a radio map (a file, local). At runtime, match the
 * live RSSI vector against the map by k-nearest-neighbour in
 * signal space. The literature says this beats pure ranging
 * for room classification (97–100% vs 46–89% in the IEEE 2025
 * testbed) — but it needs a survey walk, the map ages the
 * moment the space changes, and it is a second estimator, not
 * a replacement for the first. Keep it as a mode the user
 * picks, not the default.
 *
 * API (window.WorldmapFingerprint):
 *   recordSurveyPoint(position, rssiVector) — adds
 *     {position: {lat, lon}, vector: {sensorId: rssi}} to the
 *     radio map (persisted to localStorage). Returns the
 *     stored entry, or null for invalid input.
 *   loadRadioMap(json) — replaces the map from a JSON string
 *     (or an object / bare array); persists it. Returns
 *     {loaded, errors}.
 *   exportRadioMap() — JSON string of the map; also persists.
 *   loadStoredRadioMap() — loads the map back from
 *     localStorage (key 'arc-worldmap-radiomap'). The stored
 *     map is also auto-loaded when this file runs.
 *   clearRadioMap() / getRadioMap() / pointCount().
 *   locate(rssiVector, k=3) → {point, confidence, neighbours}
 *     by kNN in signal space: Euclidean distance over the
 *     shared sensor ids, inverse-distance weighted position
 *     average (squared kernel); confidence from neighbour
 *     agreement (how close the neighbours sit together) times
 *     signal fit (how close the best match is). Returns null
 *     when the map is empty or no survey point shares a
 *     sensor id with the vector.
 *   setMode('ranging' | 'fingerprint') / getMode() — the
 *     mode flag so the estimator can pick. Default 'ranging'.
 *
 * Pure functions, no DOM except localStorage. No randomness.
 */

var RADIOMAP_KEY = 'arc-worldmap-radiomap';
var radioMap = []; /* [{position: {lat, lon}, vector: {sensorId: rssi}}] */
var fingerprintMode = 'ranging';

function fingerprintDistanceMeters(a, b) {
  var R = 6371000, tr = Math.PI / 180;
  var dLat = (b.lat - a.lat) * tr, dLng = (b.lon - a.lon) * tr;
  var lat1 = a.lat * tr, lat2 = b.lat * tr;
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/* A survey point is usable when its position is finite and
 * its vector has at least one finite RSSI. */
function cleanSurveyPoint(position, vector) {
  if (!position || typeof position !== 'object'
    || !Number.isFinite(position.lat)
    || !Number.isFinite(position.lon)) {
    return null;
  }
  if (!vector || typeof vector !== 'object') return null;
  var clean = {};
  var count = 0;
  Object.keys(vector).forEach(function (id) {
    var rssi = Number(vector[id]);
    if (Number.isFinite(rssi)) { clean[id] = rssi; count++; }
  });
  if (!count) return null;
  return { position: { lat: position.lat, lon: position.lon }, vector: clean };
}

function saveStoredRadioMap() {
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(RADIOMAP_KEY, exportRadioMapJson());
    return true;
  } catch (e) {
    return false;
  }
}

function exportRadioMapJson() {
  return JSON.stringify({ version: 1, points: radioMap });
}

function recordSurveyPoint(position, rssiVector) {
  var entry = cleanSurveyPoint(position, rssiVector);
  if (!entry) return null;
  radioMap.push(entry);
  saveStoredRadioMap();
  return entry;
}

function getRadioMap() {
  return radioMap.map(function (p) {
    return {
      position: { lat: p.position.lat, lon: p.position.lon },
      vector: Object.assign({}, p.vector),
    };
  });
}

function pointCount() {
  return radioMap.length;
}

function clearRadioMap() {
  radioMap = [];
  if (typeof localStorage !== 'undefined') {
    try { localStorage.removeItem(RADIOMAP_KEY); } catch (e) { /* offline-safe */ }
  }
  return 0;
}

function loadRadioMap(json) {
  var data = json;
  if (typeof json === 'string') {
    var trimmed = json.trim();
    if (!trimmed) return { loaded: 0, errors: ['Empty radio map.'] };
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      return { loaded: 0, errors: ['Not valid JSON: ' + (e && e.message ? e.message : e)] };
    }
  }
  var raw = null;
  if (Array.isArray(data)) raw = data;
  else if (data && typeof data === 'object' && Array.isArray(data.points)) raw = data.points;
  if (!raw) {
    return { loaded: 0, errors: ['Expected a JSON array of survey points or {points:[...]}.'] };
  }
  var next = [];
  var errors = [];
  raw.forEach(function (p, i) {
    if (!p || typeof p !== 'object') {
      errors.push('Point ' + i + ': not an object, skipped.');
      return;
    }
    var entry = cleanSurveyPoint(p.position, p.vector);
    if (!entry) {
      errors.push('Point ' + i + ': needs a finite {lat, lon} and at least one finite RSSI, skipped.');
      return;
    }
    next.push(entry);
  });
  radioMap = next;
  saveStoredRadioMap();
  return { loaded: next.length, errors: errors };
}

function exportRadioMap() {
  var json = exportRadioMapJson();
  saveStoredRadioMap();
  return json;
}

function loadStoredRadioMap() {
  if (typeof localStorage === 'undefined') return { loaded: 0, errors: ['No localStorage.'] };
  var raw = null;
  try {
    raw = localStorage.getItem(RADIOMAP_KEY);
  } catch (e) {
    return { loaded: 0, errors: ['localStorage unreadable.'] };
  }
  if (!raw) return { loaded: 0, errors: [] };
  return loadRadioMap(raw);
}

/* Euclidean distance in signal space over the sensor ids
 * both vectors share. Infinity when they share none — such
 * a survey point says nothing about this vector. */
function signalDistance(v1, v2) {
  if (!v1 || !v2 || typeof v1 !== 'object' || typeof v2 !== 'object') return Infinity;
  var shared = Object.keys(v1).filter(function (id) {
    return Object.prototype.hasOwnProperty.call(v2, id)
      && Number.isFinite(v1[id]) && Number.isFinite(v2[id]);
  });
  if (!shared.length) return Infinity;
  var sum = 0;
  shared.forEach(function (id) {
    var diff = v1[id] - v2[id];
    sum += diff * diff;
  });
  return Math.sqrt(sum);
}

/**
 * locate(rssiVector, k=3) — kNN in signal space.
 * Returns null with an empty map, a non-object vector, or
 * no shared sensor ids. Otherwise {point, confidence,
 * neighbours}: point is the inverse-distance weighted
 * average of the k nearest survey positions; confidence
 * (0–1) is neighbour agreement — how tightly the neighbours
 * sit together — times signal fit — how close the best
 * match is in dB.
 */
function locate(rssiVector, k) {
  var kk = Number.isFinite(k) && k >= 1 ? Math.floor(k) : 3;
  if (!rssiVector || typeof rssiVector !== 'object') return null;
  if (!radioMap.length) return null;
  var scored = radioMap
    .map(function (entry) {
      return { entry: entry, d: signalDistance(rssiVector, entry.vector) };
    })
    .filter(function (s) { return Number.isFinite(s.d); });
  if (!scored.length) return null;
  scored.sort(function (a, b) { return a.d - b.d; });
  var neighbours = scored.slice(0, kk).map(function (s) {
    return {
      point: { lat: s.entry.position.lat, lon: s.entry.position.lon },
      signalDistance: s.d,
      /* Inverse-distance weight, squared kernel (Shepard's
       * method, power 2): a survey point that matches the
       * live vector closely dominates the average, so a
       * surveyed point is recovered near-exactly instead of
       * being dragged metres toward its neighbours. */
      weight: 1 / ((s.d + 1) * (s.d + 1)),
    };
  });
  var wSum = neighbours.reduce(function (acc, n) { return acc + n.weight; }, 0) || 1;
  var point = {
    lat: neighbours.reduce(function (acc, n) { return acc + n.point.lat * n.weight; }, 0) / wSum,
    lon: neighbours.reduce(function (acc, n) { return acc + n.point.lon * n.weight; }, 0) / wSum,
  };
  var agreement = 0, pairs = 0;
  for (var i = 0; i < neighbours.length; i++) {
    for (var j = i + 1; j < neighbours.length; j++) {
      agreement += fingerprintDistanceMeters(neighbours[i].point, neighbours[j].point);
      pairs++;
    }
  }
  agreement = pairs ? agreement / pairs : 0;
  var best = neighbours[0].signalDistance;
  var confidence = Math.max(0, Math.min(1,
    (1 / (1 + best / 12)) * (1 / (1 + agreement / 4))));
  return { point: point, confidence: confidence, neighbours: neighbours };
}

/* The mode flag: 'ranging' (default — the path-loss
 * estimator) or 'fingerprint' (this radio map). Returns the
 * mode after setting, or false for an unknown mode. */
function setMode(mode) {
  if (mode === 'ranging' || mode === 'fingerprint') {
    fingerprintMode = mode;
    return fingerprintMode;
  }
  return false;
}

function getMode() {
  return fingerprintMode;
}

/* Restore the stored map from a previous session, if any. */
try { loadStoredRadioMap(); } catch (e) { /* start empty */ }

if (typeof window !== 'undefined') {
  window.WorldmapFingerprint = {
    recordSurveyPoint: recordSurveyPoint,
    loadRadioMap: loadRadioMap,
    exportRadioMap: exportRadioMap,
    loadStoredRadioMap: loadStoredRadioMap,
    clearRadioMap: clearRadioMap,
    getRadioMap: getRadioMap,
    pointCount: pointCount,
    locate: locate,
    setMode: setMode,
    getMode: getMode,
    signalDistance: signalDistance,
    distanceMeters: fingerprintDistanceMeters,
    RADIOMAP_KEY: RADIOMAP_KEY,
  };
  Object.defineProperty(window.WorldmapFingerprint, 'mode', {
    get: function () { return fingerprintMode; },
  });
}
