/**
 * ARC v10 — Offline Worldmap plugin: continuum segment.
 *
 * The geospatial surface from ARC-Core (GareBear99/ARC-Core),
 * wired into the map as plain offline JS. Ports, with the
 * ARC-Core behaviour kept exact:
 *
 *   structures + perimeter geofences + calibration profiles
 *     <- arc/services/bootstrap.py (seed: Pine House, Cedar
 *        Duplex, Lakeview Home — real Williams Lake polygons
 *        around the map's default centre 52.131, -122.141)
 *   inferZone
 *     <- arc/services/geospatial.py::infer_zone (Center-Core /
 *        North / South / West / East Zone from bounds position)
 *   evaluateGeofences / continuumGeofenceHits
 *     <- arc/services/geospatial.py::estimate_track (the fence
 *        loop: structure-scoped fences plus global ones)
 *   arcCandidateCloud
 *     <- arc/services/geospatial.py::_candidate_cloud (16 pts,
 *        radius proportional to (1 - confidence), points outside
 *        the structure polygon dropped)
 *   continuumHeatmap
 *     <- arc/services/geospatial.py::get_heatmap (grid_size x
 *        grid_size cells over the structure bbox, cell centres
 *        outside the polygon discarded, count + mean confidence)
 *   arcCalibrationToProfile
 *     <- arc/services/geospatial.py::create_calibration_profile
 *        ({path_loss, noise_db, smoothing} per structure)
 *   blueprint overlay records
 *     <- arc/services/geospatial.py::upsert_blueprint_overlay
 *        ({name, opacity, scale, offset_x, offset_y,
 *        rotation_deg, floor} keyed by (structure, name, floor))
 *   the /ui geo page layout (geo.html): structures / tracks /
 *     heatmap / blueprints / calibrations / incidents / receipts
 *     — the panel section in index.html mirrors it.
 *
 * What is deliberately NOT here (Future in ARC-Core,
 * docs/CONTINUUM_COMPARISON.md §4-§5 — not implemented, not
 * claimed): 3D / city-scale spatial (v8 R5-R7), streaming
 * ingest + push comms (v7 R1-R2), multilateration as an
 * ARC-Core method (the plugin already has its own, older one),
 * receipt-chain / tamper-evident geo state, risk decay,
 * multi-tenant isolation, key rotation, CMR/HUD hardware.
 * ARC-Core v6 also stores calibration profiles but does NOT
 * thread them into its forward model (known v6 limit,
 * docs/ARCHITECTURE.md §14); the plugin DOES thread the
 * seeded profile (see arc/pathloss.js 'arc-default').
 *
 * The blueprint seed in ARC-Core points at an example.local
 * placeholder URL that is never fetched. The plugin stores no
 * URL at all: the record exists, the image is attached from a
 * local file the user picks (object URL, in-memory only, same
 * pattern as the .mbtiles pack) and nothing is fetched.
 *
 * Load after geo.js. No network, no dependencies.
 */

/**
 * The three seeded structures (bootstrap.py). ARC-Core generates
 * ids like `str-<24 hex>`; the plugin uses stable readable ids
 * for the same three structures.
 */
const CONTINUUM_STRUCTURES = [
  {
    id: 'str-pine-house',
    name: 'Pine House',
    address: '100 Pine Ave',
    structure_type: 'house',
    levels: 1,
    polygon: [
      [52.13188, -122.14235],
      [52.13188, -122.14203],
      [52.13168, -122.14203],
      [52.13168, -122.14235],
    ],
  },
  {
    id: 'str-cedar-duplex',
    name: 'Cedar Duplex',
    address: '118 Cedar St',
    structure_type: 'duplex',
    levels: 2,
    polygon: [
      [52.13156, -122.14174],
      [52.13156, -122.14137],
      [52.13132, -122.14137],
      [52.13132, -122.14174],
    ],
  },
  {
    id: 'str-lakeview-home',
    name: 'Lakeview Home',
    address: '240 Lakeview Dr',
    structure_type: 'house',
    levels: 2,
    polygon: [
      [52.13207, -122.14148],
      [52.13207, -122.14112],
      [52.13179, -122.14112],
      [52.13179, -122.14148],
    ],
  },
];

/** One perimeter geofence per structure (bootstrap.py: severity 5). */
const CONTINUUM_GEOFENCES = CONTINUUM_STRUCTURES.map((s) => ({
  geofence_id: s.id + '-perimeter',
  name: s.name + ' Perimeter',
  geofence_type: 'structure',
  structure_id: s.id,
  polygon: s.polygon,
  severity: 5,
}));

/** One seeded calibration profile per structure (bootstrap.py). */
const CONTINUUM_CALIBRATIONS = CONTINUUM_STRUCTURES.map((s) => ({
  profile_id: s.id + '-cal',
  structure_id: s.id,
  name: s.name + ' Default',
  profile: { path_loss: 2.2, noise_db: 3.5, smoothing: 0.65 },
  notes: 'Seeded indoor profile',
}));

/** One blueprint overlay record per structure (bootstrap.py).
 *  image_url is null until the user attaches a local image file;
 *  the record's geometry (opacity/scale/offset/rotation/floor)
 *  is the ARC-Core shape, kept verbatim. */
const CONTINUUM_BLUEPRINTS = CONTINUUM_STRUCTURES.map((s) => ({
  overlay_id: s.id + '-ovr',
  structure_id: s.id,
  name: s.name + ' Floorplan',
  image_url: null,
  opacity: 0.45,
  scale: 1.0,
  offset_x: 0.0,
  offset_y: 0.0,
  rotation_deg: 0.0,
  floor: 1,
}));

/** Attached blueprint images: overlay_id -> object URL.
 *  In-memory only — a file cannot persist itself (same rule
 *  as the .mbtiles pack); the record above survives, the
 *  image is re-picked next session. */
const _blueprintImages = {};

function structureById(structureId) {
  return CONTINUUM_STRUCTURES.find((s) => s.id === structureId) || null;
}

/** First seeded structure whose polygon contains the point. */
function structureContaining(point) {
  if (!point || typeof WorldmapGeo === 'undefined') return null;
  const p = WorldmapGeo.asPoint(point);
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return null;
  return CONTINUUM_STRUCTURES.find((s) => WorldmapGeo.pointInPolygon(p, s.polygon)) || null;
}

/**
 * Zone classification (geospatial.py::infer_zone, exact):
 * normalise the point to [0,1] inside the structure bounds;
 * |rx-0.5|<0.18 and |ry-0.5|<0.18 -> "Center-Core";
 * ry<0.33 -> "North Zone"; ry>0.66 -> "South Zone";
 * else rx<0.5 -> "West Zone" else "East Zone".
 */
function inferZone(polygon, point) {
  const g = WorldmapGeo;
  const bounds = g.boundsFromPolygon(polygon);
  const p = g.asPoint(point);
  const width = bounds.maxLon - bounds.minLon;
  const height = bounds.maxLat - bounds.minLat;
  const rx = (p.lon - bounds.minLon) / (width || 1);
  const ry = (p.lat - bounds.minLat) / (height || 1);
  if (Math.abs(rx - 0.5) < 0.18 && Math.abs(ry - 0.5) < 0.18) return 'Center-Core';
  if (ry < 0.33) return 'North Zone';
  if (ry > 0.66) return 'South Zone';
  if (rx < 0.5) return 'West Zone';
  return 'East Zone';
}

/**
 * Geofence hits for a point (geospatial.py::estimate_track
 * fence loop, exact shape): every fence in the given list
 * whose polygon contains the point, as
 * {geofence_id, name, severity, geofence_type}.
 */
function evaluateGeofences(point, geofences) {
  const hits = [];
  (geofences || []).forEach((fence) => {
    if (!fence || !Array.isArray(fence.polygon)) return;
    if (WorldmapGeo.pointInPolygon(point, fence.polygon)) {
      hits.push({
        geofence_id: fence.geofence_id,
        name: fence.name,
        severity: fence.severity,
        geofence_type: fence.geofence_type,
      });
    }
  });
  return hits;
}

/**
 * The fences that apply to a point: the fences of the
 * structure containing it, plus any global (structure_id null)
 * fences — ARC-Core's `WHERE structure_id=? OR structure_id
 * IS NULL` query, applied to the point.
 */
function continuumGeofenceHits(point) {
  const structure = structureContaining(point);
  const applicable = CONTINUUM_GEOFENCES.filter(
    (f) => !f.structure_id || (structure && f.structure_id === structure.id),
  );
  return evaluateGeofences(point, applicable);
}

/**
 * Zone + geofence hits for one fix — the estimate_track
 * pipeline minus the estimator and the receipt: classify,
 * then check the fences. Returns
 * {structureId, zone, geofenceHits}.
 */
function continuumGeoFor(point) {
  const structure = structureContaining(point);
  return {
    structureId: structure ? structure.id : null,
    zone: structure ? inferZone(structure.polygon, point) : null,
    geofenceHits: continuumGeofenceHits(point),
  };
}

/**
 * Candidate cloud (geospatial.py::_candidate_cloud, exact):
 * up to `count` points around `point`, radius proportional
 * to (1 - confidence), points outside the structure polygon
 * dropped. Deterministic: evenly spaced angles, no RNG.
 */
function arcCandidateCloud(structure, point, confidence, count) {
  const n = Math.max(0, Math.min(64, Number(count) || 16));
  const cloud = [];
  if (!structure || !point || !n) return cloud;
  const polygon = Array.isArray(structure) ? structure : structure.polygon;
  if (!Array.isArray(polygon) || polygon.length < 3) return cloud;
  const p = WorldmapGeo.asPoint(point);
  const conf = Math.max(0, Math.min(1, typeof confidence === 'number' ? confidence : 0.5));
  const bounds = WorldmapGeo.boundsFromPolygon(polygon);
  const latSpan = Math.max(0.00001, bounds.maxLat - bounds.minLat);
  const lngSpan = Math.max(0.00001, bounds.maxLon - bounds.minLon);
  const radiusLat = latSpan * (0.02 + (1 - conf) * 0.12);
  const radiusLng = lngSpan * (0.02 + (1 - conf) * 0.12);
  for (let idx = 0; idx < n; idx++) {
    const angle = (idx / n) * 2 * Math.PI;
    const scale = 0.55 + ((idx % 4) / 6);
    const candidate = {
      lat: p.lat + radiusLat * scale * Math.sin(angle),
      lon: p.lon + radiusLng * scale * Math.cos(angle),
    };
    if (WorldmapGeo.pointInPolygon(candidate, polygon)) cloud.push(candidate);
  }
  return cloud;
}

/**
 * Track-density heatmap grid (geospatial.py::get_heatmap,
 * exact): the structure bbox split into grid_size x grid_size
 * cells; cells whose centre falls outside the polygon are
 * discarded; each kept cell reports the count of track points
 * inside it and the mean of their confidences.
 * tracks: [{lat, lon, confidence}]. grid_size clamped to
 * [2, 64] (ARC-Core MAX_GRID_SIZE default 64).
 * Returns {structure_id, grid_size, cells:[{gx, gy, count,
 * mean_confidence, center:{lat, lon}}]}.
 */
function continuumHeatmap(structure, tracks, gridSize) {
  const grid = Math.max(2, Math.min(64, Number(gridSize) || 8));
  const polygon = Array.isArray(structure) ? structure : structure.polygon;
  const structureId = (structure && structure.id) || null;
  const bounds = WorldmapGeo.boundsFromPolygon(polygon);
  const points = Array.isArray(tracks) ? tracks : [];
  const cells = [];
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const minLat = bounds.minLat + (bounds.maxLat - bounds.minLat) * (gy / grid);
      const maxLat = bounds.minLat + (bounds.maxLat - bounds.minLat) * ((gy + 1) / grid);
      const minLon = bounds.minLon + (bounds.maxLon - bounds.minLon) * (gx / grid);
      const maxLon = bounds.minLon + (bounds.maxLon - bounds.minLon) * ((gx + 1) / grid);
      const center = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
      if (!WorldmapGeo.pointInPolygon(center, polygon)) continue;
      let count = 0;
      let confSum = 0;
      points.forEach((t) => {
        const p = WorldmapGeo.asPoint(t);
        if (minLat <= p.lat && p.lat <= maxLat && minLon <= p.lon && p.lon <= maxLon) {
          count += 1;
          confSum += typeof t.confidence === 'number' ? t.confidence : 0;
        }
      });
      cells.push({
        gx,
        gy,
        count,
        mean_confidence: count ? Number((confSum / count).toFixed(3)) : 0,
        center,
      });
    }
  }
  return { structure_id: structureId, grid_size: grid, cells };
}

/**
 * ARC-Core calibration profile -> plugin profile object.
 * {path_loss, noise_db, smoothing} maps to the plugin's
 * {n (path-loss exponent), noise, smooth}; attenuation 1.0
 * (no attenuation value in the ARC-Core record) and decay
 * 0.82 (the plugin's balanced default). The plugin threads
 * these into the estimator — ARC-Core v6 does not.
 */
function arcCalibrationToProfile(arcProfile) {
  const p = arcProfile || {};
  return {
    name: 'ARC-Core Default',
    n: typeof p.path_loss === 'number' ? p.path_loss : 2.2,
    noise: typeof p.noise_db === 'number' ? p.noise_db : 3.5,
    smooth: typeof p.smoothing === 'number' ? p.smoothing : 0.65,
    attenuation: 1.0,
    decay: 0.82,
  };
}

/** Blueprint overlays, optionally narrowed to one structure. */
function listBlueprintOverlays(structureId) {
  const rows = structureId
    ? CONTINUUM_BLUEPRINTS.filter((b) => b.structure_id === structureId)
    : CONTINUUM_BLUEPRINTS.slice();
  return rows.map((b) => ({
    ...b,
    image_url: _blueprintImages[b.overlay_id] || b.image_url,
    imageLoaded: Boolean(_blueprintImages[b.overlay_id]),
  }));
}

/**
 * Attach a local image file to a structure's blueprint overlay
 * (user-picked, object URL — nothing fetched, nothing uploaded).
 * Returns the overlay record, or null for an unknown structure.
 */
function attachBlueprintImage(structureId, file) {
  const overlay = CONTINUUM_BLUEPRINTS.find((b) => b.structure_id === structureId);
  if (!overlay || !file) return null;
  try {
    if (_blueprintImages[overlay.overlay_id]) URL.revokeObjectURL(_blueprintImages[overlay.overlay_id]);
  } catch (e) {
    // No prior image — nothing to revoke.
  }
  let url = null;
  try {
    url = URL.createObjectURL(file);
  } catch (e) {
    return null;
  }
  _blueprintImages[overlay.overlay_id] = url;
  return { ...overlay, image_url: url, imageLoaded: true };
}

const WorldmapContinuum = {
  CONTINUUM_STRUCTURES,
  CONTINUUM_GEOFENCES,
  CONTINUUM_CALIBRATIONS,
  CONTINUUM_BLUEPRINTS,
  structureById,
  structureContaining,
  inferZone,
  evaluateGeofences,
  continuumGeofenceHits,
  continuumGeoFor,
  arcCandidateCloud,
  continuumHeatmap,
  arcCalibrationToProfile,
  listBlueprintOverlays,
  attachBlueprintImage,
};

if (typeof window !== 'undefined') window.WorldmapContinuum = WorldmapContinuum;
