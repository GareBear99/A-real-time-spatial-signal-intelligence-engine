/**
 * ARC v10 — Offline Worldmap plugin: geometry.
 *
 * Plain-JS geo helpers ported from the v8.9 bundle
 * (ARC_Spatial_Intelligence_RG_Fusion_v8_9/app/arc/app.bundle.js).
 * The v8 bundle uses {lat, lng}; the plugin uses {lat, lon}.
 * Everything here accepts either spelling on input and returns
 * {lat, lon} (plus an lng alias where v8 code expects one).
 *
 * No network, no dependencies. Load order: this file first —
 * pathloss.js, estimator.js, filter.js, lab.js, sensors.js,
 * simulator.js and triangulation.js all use it.
 */

const EARTH_RADIUS_M = 6371000;

function lonOf(p) {
  if (!p) return NaN;
  if (typeof p.lon === 'number') return p.lon;
  if (typeof p.lng === 'number') return p.lng;
  if (Array.isArray(p)) return p[1];
  return NaN;
}

function latOf(p) {
  if (!p) return NaN;
  if (typeof p.lat === 'number') return p.lat;
  if (Array.isArray(p)) return p[0];
  return NaN;
}

/** Normalise a [lat, lon] pair or a {lat, lon|lng} object. */
function asPoint(p) {
  return { lat: latOf(p), lon: lonOf(p) };
}

/** Haversine distance in metres (v8: distanceMeters). */
function distanceMeters(a, b) {
  const pa = asPoint(a);
  const pb = asPoint(b);
  const R = EARTH_RADIUS_M;
  const tr = Math.PI / 180;
  const dLat = (pb.lat - pa.lat) * tr;
  const dLon = (pb.lon - pa.lon) * tr;
  const lat1 = pa.lat * tr;
  const lat2 = pb.lat * tr;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Mean of a polygon's vertices (v8: centroid). Polygon is an
 *  array of [lat, lon] pairs or {lat, lon|lng} points. */
function centroid(poly) {
  const pts = poly.map(asPoint);
  const sum = pts.reduce((acc, p) => ({ lat: acc.lat + p.lat, lon: acc.lon + p.lon }), { lat: 0, lon: 0 });
  return { lat: sum.lat / pts.length, lon: sum.lon / pts.length, lng: sum.lon / pts.length };
}

/** Bounding box of a polygon (v8: boundsFromPolygon). */
function boundsFromPolygon(poly) {
  const pts = poly.map(asPoint);
  const lats = pts.map((p) => p.lat);
  const lons = pts.map((p) => p.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  return { minLat, maxLat, minLon, maxLon, minLng: minLon, maxLng: maxLon };
}

/** Ray-casting point-in-polygon (v8: pointInPolygon). */
function pointInPolygon(point, polygon) {
  const p = asPoint(point);
  const poly = polygon.map(asPoint);
  const x = p.lon;
  const y = p.lat;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lon;
    const yi = poly[i].lat;
    const xj = poly[j].lon;
    const yj = poly[j].lat;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Clamp a point into a bounding box (v8: clampPointToBounds). */
function clampPointToBounds(point, bounds) {
  const p = asPoint(point);
  const minLon = bounds.minLon !== undefined ? bounds.minLon : bounds.minLng;
  const maxLon = bounds.maxLon !== undefined ? bounds.maxLon : bounds.maxLng;
  return {
    lat: Math.min(bounds.maxLat, Math.max(bounds.minLat, p.lat)),
    lon: Math.min(maxLon, Math.max(minLon, p.lon)),
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpPoint(a, b, t) {
  const pa = asPoint(a);
  const pb = asPoint(b);
  return { lat: lerp(pa.lat, pb.lat, t), lon: lerp(pa.lon, pb.lon, t) };
}

/**
 * Mulberry32-style seeded RNG (v8: seeded). Same seed ->
 * same sequence, forever. seed is any number.
 */
function seeded(seed) {
  let t = Math.floor(seed * 1e6) ^ 0x9e3779b9;
  return function () {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Same generator under v8's other name (v8: randomSeededInt). */
function randomSeededInt(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded random point inside a polygon (v8: seededPointInPolygon). */
function seededPointInPolygon(polygon, seed) {
  const bounds = boundsFromPolygon(polygon);
  const rnd = seeded(seed);
  for (let i = 0; i < 800; i++) {
    const p = {
      lat: bounds.minLat + (bounds.maxLat - bounds.minLat) * rnd(),
      lon: bounds.minLon + (bounds.maxLon - bounds.minLon) * rnd(),
    };
    if (pointInPolygon(p, polygon)) return p;
  }
  return centroid(polygon);
}

/**
 * Local tangent-plane metres around a reference point.
 * x = east, y = north. Accurate to centimetres over the
 * tens-of-metres spans this plugin works in.
 */
function toLocalMeters(lat, lon, refLat, refLon) {
  const tr = Math.PI / 180;
  const x = (lon - refLon) * tr * EARTH_RADIUS_M * Math.cos(refLat * tr);
  const y = (lat - refLat) * tr * EARTH_RADIUS_M;
  return { x, y };
}

/** Inverse of toLocalMeters. ref is {lat, lon|lng}. */
function fromLocalMeters(x, y, ref) {
  const r = asPoint(ref);
  const tr = Math.PI / 180;
  const lat = r.lat + (y / EARTH_RADIUS_M) / tr;
  const lon = r.lon + (x / (EARTH_RADIUS_M * Math.cos(r.lat * tr))) / tr;
  return { lat, lon };
}

const WorldmapGeo = {
  EARTH_RADIUS_M,
  distanceMeters,
  centroid,
  boundsFromPolygon,
  pointInPolygon,
  clampPointToBounds,
  lerp,
  lerpPoint,
  seeded,
  randomSeededInt,
  seededPointInPolygon,
  toLocalMeters,
  fromLocalMeters,
  asPoint,
  lonOf,
  latOf,
};

if (typeof window !== 'undefined') window.WorldmapGeo = WorldmapGeo;
