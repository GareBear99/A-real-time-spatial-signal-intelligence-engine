/**
 * ARC v10 — Offline Worldmap plugin: honest RF visualisation.
 *
 * This REPLACES arc/webgl_rf.js (which drew 12 concentric rings
 * at a RANDOM x/y, ignoring the signal entirely — and was 2D
 * canvas, not WebGL, despite the name). This file is 2D canvas
 * and says so. No randomness anywhere in this file: every ring
 * is centred on a real sensor position and its radius comes
 * from the RSSI-derived distance through the log-distance
 * path-loss model:
 *
 *   d = 10 ^ ((rssiAt1m - rssi) / (10 * n))
 *
 * with rssiAt1m = -62 dBm and n = 2 by default, or the values
 * from a calibration profile when one is passed. Ring opacity
 * fades with the measured noise from the same calibration.
 *
 * API (globals, so the existing call sites keep working):
 *   initRF()  — same as before: canvas#rf sized to the window.
 *   drawRF(sensorPositions, observations, calibration)
 *             — rings for every observation, each centred on
 *               its sensor. sensorPositions: [{id, lat, lon}];
 *               observations: [{sensorId, rssi}] (also accepts
 *               {sensor:{id}, rssi} and {sensorId: rssi} maps).
 *   drawRF(sig) — the old single-signal call site
 *               (triangulation.js): a ring set centred on that
 *               signal's sensor when sig.sensorId matches a
 *               known sensor (see setRFSensors), else centred
 *               on the map centre. Never a random x/y.
 *   setRFSensors(list) / getRFSensors() — the known-sensor
 *               registry the single-signal form looks up.
 *
 * drawRF returns the rings it drew
 * ([{sensorId, distanceM, x, y, radiusPx, alpha, ...}]) so the
 * geometry is testable without a screen. All functions are also
 * attached to window.WorldmapRF.
 *
 * Lat/lon → canvas pixels uses the Leaflet map when one exists
 * (map.latLngToContainerPoint); without a map it falls back to
 * an equirectangular projection around the map centre at
 * zoom 15, so the file still works standalone and in tests.
 */

/* Log-distance path-loss defaults (step 1's model). */
var RF_DEFAULT_RSSI_AT_1M = -62;
var RF_DEFAULT_PATH_LOSS_N = 2;
var RF_DEFAULT_CENTRE = { lat: 52.131, lon: -122.141 };

var rfCanvas = null;
var rfCtx = null;
/* Known sensors: [{id, lat, lon}]. Populated by the sensor
 * work (step 2) via setRFSensors; empty until then, which is
 * why the single-signal form falls back to the map centre. */
var rfSensors = [];

function initRF() {
  if (typeof document === 'undefined') return false;
  rfCanvas = document.getElementById('rf');
  if (!rfCanvas) return false;
  rfCanvas.width = window.innerWidth;
  rfCanvas.height = window.innerHeight;
  rfCtx = rfCanvas.getContext('2d');
  return !!rfCtx;
}

/** RSSI (dBm) → distance (m) by log-distance path loss.
 *  Returns null for a non-finite RSSI. */
function rssiToDistance(rssi, calibration) {
  if (!Number.isFinite(rssi)) return null;
  var cal = normalizeCalibration(calibration);
  var d = Math.pow(10, (cal.rssiAt1m - rssi) / (10 * cal.n));
  if (!Number.isFinite(d)) return null;
  return Math.min(1000, Math.max(0.1, d));
}

/** Accept {rssiAt1m, n, noise} or the {rssi1m,
 *  pathLossExponent} spellings; fill defaults. */
function normalizeCalibration(calibration) {
  var c = calibration || {};
  var rssiAt1m = Number.isFinite(c.rssiAt1m) ? c.rssiAt1m
    : Number.isFinite(c.rssi1m) ? c.rssi1m : RF_DEFAULT_RSSI_AT_1M;
  var n = Number.isFinite(c.n) ? c.n
    : Number.isFinite(c.pathLossExponent) ? c.pathLossExponent
    : RF_DEFAULT_PATH_LOSS_N;
  var noise = Number.isFinite(c.noise) ? c.noise : 3;
  return { rssiAt1m: rssiAt1m, n: Math.max(1, n), noise: Math.max(0, noise) };
}

function setRFSensors(list) {
  rfSensors = (Array.isArray(list) ? list : [])
    .filter(function (s) {
      return s && typeof s.id !== 'undefined'
        && Number.isFinite(s.lat) && Number.isFinite(s.lon);
    })
    .map(function (s) { return { id: s.id, lat: s.lat, lon: s.lon }; });
  return rfSensors.length;
}

function getRFSensors() {
  return rfSensors.map(function (s) { return { id: s.id, lat: s.lat, lon: s.lon }; });
}

/** Map centre: the Leaflet map when present, else the plugin
 *  default centre. Never random. */
function rfMapCentre() {
  if (typeof map !== 'undefined' && map && typeof map.getCenter === 'function') {
    var c = map.getCenter();
    if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
      return { lat: c.lat, lon: c.lng };
    }
    if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
      return { lat: c.lat, lon: c.lon };
    }
  }
  return { lat: RF_DEFAULT_CENTRE.lat, lon: RF_DEFAULT_CENTRE.lon };
}

function rfCanvasSize() {
  if (rfCanvas) return { width: rfCanvas.width, height: rfCanvas.height };
  if (typeof window !== 'undefined') {
    return { width: window.innerWidth || 1024, height: window.innerHeight || 768 };
  }
  return { width: 1024, height: 768 };
}

/** Lat/lon → canvas pixels. Leaflet projection when a map
 *  exists, equirectangular fallback around the centre at
 *  zoom 15 otherwise. */
function latLonToXY(lat, lon) {
  if (typeof map !== 'undefined' && map && typeof map.latLngToContainerPoint === 'function') {
    var p = map.latLngToContainerPoint([lat, lon]);
    return { x: p.x, y: p.y };
  }
  var size = rfCanvasSize();
  var centre = rfMapCentre();
  var pxPerDegree = (256 * Math.pow(2, 15)) / 360;
  return {
    x: size.width / 2 + (lon - centre.lon) * pxPerDegree * Math.cos(centre.lat * Math.PI / 180),
    y: size.height / 2 - (lat - centre.lat) * pxPerDegree,
  };
}

/** Metres → canvas pixels at a latitude. Leaflet projection
 *  when a map exists, Web-Mercator zoom-15 scale otherwise. */
function metersToPixels(metres, lat) {
  if (typeof map !== 'undefined' && map && typeof map.latLngToContainerPoint === 'function') {
    var centre = rfMapCentre();
    var p0 = map.latLngToContainerPoint([lat, centre.lon]);
    var p1 = map.latLngToContainerPoint([lat + metres / 111320, centre.lon]);
    return Math.abs(p1.y - p0.y);
  }
  var pxPerMetre = (256 * Math.pow(2, 15))
    / (2 * Math.PI * 6378137 * Math.cos(lat * Math.PI / 180));
  return metres * pxPerMetre;
}

/** Ring opacity from measured noise (dB): noisier scans get
 *  fainter rings. 0.25–0.9, 0.75 at the default noise of 3 dB. */
function noiseAlpha(noiseDb) {
  return Math.max(0.25, Math.min(0.9, 1 - noiseDb / 12));
}

/** One ring entry per observation: centre in canvas pixels,
 *  radius from the RSSI-derived distance, plus the ±1-sigma
 *  distance bounds implied by the RSSI noise. Observations
 *  with no matching sensor or no finite RSSI are skipped —
 *  a ring with no sensor behind it is not drawn. */
function computeRings(sensorPositions, observations, calibration) {
  var cal = normalizeCalibration(calibration);
  var byId = {};
  (Array.isArray(sensorPositions) ? sensorPositions : []).forEach(function (s) {
    if (s && typeof s.id !== 'undefined'
      && Number.isFinite(s.lat) && Number.isFinite(s.lon)) {
      byId[s.id] = s;
    }
  });
  var list = [];
  if (Array.isArray(observations)) {
    list = observations;
  } else if (observations && typeof observations === 'object') {
    /* {sensorId: rssi} map form. */
    list = Object.keys(observations).map(function (id) {
      return { sensorId: id, rssi: observations[id] };
    });
  }
  var rings = [];
  list.forEach(function (obs) {
    if (!obs || typeof obs !== 'object') return;
    var sensorId = obs.sensorId
      || (obs.sensor && typeof obs.sensor === 'object' ? obs.sensor.id : obs.sensor)
      || null;
    var sensor = sensorId !== null ? byId[sensorId] : null;
    if (!sensor) return;
    var d = rssiToDistance(obs.rssi, cal);
    if (d === null) return;
    var xy = latLonToXY(sensor.lat, sensor.lon);
    var radiusPx = metersToPixels(d, sensor.lat);
    /* Relative distance error from RSSI noise: d(d)/d(rssi)
     * for d = 10^((rssiAt1m - rssi)/(10n)) is ln(10)/(10n)
     * per dB, so a noise of sigma dB spreads the radius by
     * that fraction. */
    var relErr = Math.LN10 * cal.noise / (10 * cal.n);
    rings.push({
      sensorId: sensorId,
      distanceM: d,
      x: xy.x,
      y: xy.y,
      radiusPx: radiusPx,
      alpha: noiseAlpha(cal.noise),
      innerPx: Math.max(1, radiusPx * (1 - relErr)),
      outerPx: radiusPx * (1 + relErr),
    });
  });
  return rings;
}

function strokeRing(ring) {
  if (!rfCtx) return;
  rfCtx.beginPath();
  rfCtx.arc(ring.x, ring.y, Math.max(1, ring.radiusPx), 0, Math.PI * 2);
  rfCtx.strokeStyle = 'rgba(0,255,0,' + ring.alpha.toFixed(3) + ')';
  rfCtx.stroke();
  /* The ±1-sigma bounds, fainter: the honest part — the ring
   * is an estimate with a width, not a sharp circle. */
  var faint = (ring.alpha * 0.35).toFixed(3);
  rfCtx.beginPath();
  rfCtx.arc(ring.x, ring.y, Math.max(1, ring.innerPx), 0, Math.PI * 2);
  rfCtx.strokeStyle = 'rgba(0,255,0,' + faint + ')';
  rfCtx.stroke();
  rfCtx.beginPath();
  rfCtx.arc(ring.x, ring.y, Math.max(1, ring.outerPx), 0, Math.PI * 2);
  rfCtx.strokeStyle = 'rgba(0,255,0,' + faint + ')';
  rfCtx.stroke();
}

/**
 * drawRF — two forms, both deterministic:
 *   drawRF(sensorPositions, observations, calibration)
 *   drawRF(sig)  — old call site (triangulation.js): sig is one
 *     signal {sensorId?, rssi}; the ring set is centred on
 *     that signal's sensor when sensorId matches a known
 *     sensor, else on the map centre. A signal with no finite
 *     RSSI draws nothing — there is no distance to draw.
 * Returns the rings drawn ([] when nothing could be drawn).
 */
function drawRF(a, b, c) {
  if (rfCtx && rfCanvas) {
    rfCtx.clearRect(0, 0, rfCanvas.width, rfCanvas.height);
  }
  if (!rfCtx) return [];
  var rings = [];
  if (Array.isArray(a)) {
    rings = computeRings(a, b, c);
  } else if (a && typeof a === 'object' && Number.isFinite(a.rssi)) {
    var cal = normalizeCalibration(b && typeof b === 'object' ? b : null);
    var sensor = null;
    if (a.sensorId !== undefined && a.sensorId !== null) {
      for (var i = 0; i < rfSensors.length; i++) {
        if (rfSensors[i].id === a.sensorId) { sensor = rfSensors[i]; break; }
      }
    }
    var centre = sensor
      ? { lat: sensor.lat, lon: sensor.lon }
      : rfMapCentre();
    var d = rssiToDistance(a.rssi, cal);
    if (d === null) return [];
    var xy = latLonToXY(centre.lat, centre.lon);
    var radiusPx = metersToPixels(d, centre.lat);
    var relErr = Math.LN10 * cal.noise / (10 * cal.n);
    rings = [{
      sensorId: sensor ? sensor.id : (a.sensorId !== undefined ? a.sensorId : null),
      distanceM: d,
      x: xy.x,
      y: xy.y,
      radiusPx: radiusPx,
      alpha: noiseAlpha(cal.noise),
      innerPx: Math.max(1, radiusPx * (1 - relErr)),
      outerPx: radiusPx * (1 + relErr),
    }];
  }
  rings.forEach(strokeRing);
  return rings;
}

if (typeof window !== 'undefined') {
  window.WorldmapRF = {
    initRF: initRF,
    drawRF: drawRF,
    setRFSensors: setRFSensors,
    getRFSensors: getRFSensors,
    rssiToDistance: rssiToDistance,
    computeRings: computeRings,
    latLonToXY: latLonToXY,
    metersToPixels: metersToPixels,
    DEFAULT_RSSI_AT_1M: RF_DEFAULT_RSSI_AT_1M,
    DEFAULT_PATH_LOSS_N: RF_DEFAULT_PATH_LOSS_N,
  };
  /* Globals for the existing call sites (boot in index.html,
   * the bus handler in triangulation.js). */
  window.initRF = initRF;
  window.drawRF = drawRF;
}
