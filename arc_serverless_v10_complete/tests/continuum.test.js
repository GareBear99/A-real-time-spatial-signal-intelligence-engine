'use strict';
/**
 * Continuum segment tests (node:test, no dependencies).
 *
 * Loads the plugin's plain-JS engine files in a vm sandbox
 * (window === global, like the browser page) and checks the
 * ARC-Core ports against the ARC-Core sources, plus the
 * pre-existing estimators as a regression guard.
 *
 * Run: npm test   (node --test arc_serverless_v10_complete/tests/)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadEngine() {
  const dir = path.join(__dirname, '..', 'arc');
  const sandbox = { console };
  sandbox.window = sandbox; // arc files attach to window.*; make it the global
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of ['geo.js', 'pathloss.js', 'estimator.js', 'continuum.js', 'evidence.js', 'lab.js']) {
    vm.runInContext(fs.readFileSync(path.join(dir, file), 'utf8'), sandbox, { filename: file });
  }
  return sandbox;
}

const E = loadEngine();
const { WorldmapGeo, WorldmapPathloss, WorldmapEstimator, WorldmapContinuum, WorldmapEvidence, WorldmapLab } = E;

/** Values built inside the vm realm fail deepStrictEqual against host-realm
 *  literals (different Array/Object prototypes) — normalise via JSON. */
const plain = (x) => JSON.parse(JSON.stringify(x));

const PINE = [
  [52.13188, -122.14235],
  [52.13188, -122.14203],
  [52.13168, -122.14203],
  [52.13168, -122.14235],
];

test('seed structures match ARC-Core bootstrap.py exactly', () => {
  assert.equal(WorldmapContinuum.CONTINUUM_STRUCTURES.length, 3);
  const names = WorldmapContinuum.CONTINUUM_STRUCTURES.map((s) => s.name);
  assert.deepEqual(plain(names), ['Pine House', 'Cedar Duplex', 'Lakeview Home']);
  assert.deepEqual(plain(WorldmapContinuum.CONTINUUM_STRUCTURES[0].polygon), PINE);
  assert.equal(WorldmapContinuum.CONTINUUM_STRUCTURES[0].address, '100 Pine Ave');
  assert.equal(WorldmapContinuum.CONTINUUM_STRUCTURES[0].levels, 1);
  assert.equal(WorldmapContinuum.CONTINUUM_STRUCTURES[1].levels, 2);
  // Centre is the map default (Williams Lake): all three sit
  // within ~150 m of 52.131, -122.141.
  WorldmapContinuum.CONTINUUM_STRUCTURES.forEach((s) => {
    const c = WorldmapGeo.centroid(s.polygon);
    assert.ok(WorldmapGeo.distanceMeters(c, { lat: 52.131, lon: -122.141 }) < 200);
  });
});

test('perimeter geofences + calibration profiles match the ARC-Core seed', () => {
  assert.equal(WorldmapContinuum.CONTINUUM_GEOFENCES.length, 3);
  const fence = WorldmapContinuum.CONTINUUM_GEOFENCES[0];
  assert.equal(fence.name, 'Pine House Perimeter');
  assert.equal(fence.geofence_type, 'structure');
  assert.equal(fence.severity, 5);
  assert.deepEqual(plain(fence.polygon), PINE);
  assert.equal(WorldmapContinuum.CONTINUUM_CALIBRATIONS.length, 3);
  WorldmapContinuum.CONTINUUM_CALIBRATIONS.forEach((c) => {
    assert.deepEqual(plain(c.profile), { path_loss: 2.2, noise_db: 3.5, smoothing: 0.65 });
  });
  assert.equal(WorldmapContinuum.CONTINUUM_BLUEPRINTS.length, 3);
  assert.equal(WorldmapContinuum.CONTINUUM_BLUEPRINTS[0].opacity, 0.45);
  assert.equal(WorldmapContinuum.CONTINUUM_BLUEPRINTS[0].floor, 1);
  // No network placeholder: the plugin stores no image URL.
  assert.equal(WorldmapContinuum.CONTINUUM_BLUEPRINTS[0].image_url, null);
});

test('inferZone matches ARC-Core geospatial.py::infer_zone', () => {
  const poly = PINE;
  const c = WorldmapGeo.centroid(poly);
  assert.equal(WorldmapContinuum.inferZone(poly, c), 'Center-Core');
  // Bounds: lat 52.13168..52.13188, lon -122.14235..-122.14203.
  assert.equal(WorldmapContinuum.inferZone(poly, { lat: 52.1317, lon: -122.14219 }), 'North Zone');
  assert.equal(WorldmapContinuum.inferZone(poly, { lat: 52.13186, lon: -122.14219 }), 'South Zone');
  assert.equal(WorldmapContinuum.inferZone(poly, { lat: 52.13178, lon: -122.14232 }), 'West Zone');
  assert.equal(WorldmapContinuum.inferZone(poly, { lat: 52.13178, lon: -122.14206 }), 'East Zone');
});

test('weighted-RSSI centroid matches ARC-Core estimator.py exactly', () => {
  // Two sensors, RSSIs -60 and -72, reliabilities 1.0 and 0.5.
  // wA/wB = 10^((−60+72)/12) / 0.5 = 10/0.5 = 20.
  const obs = [
    { sensor: { lat: 52.1318, lon: -122.1422 }, rssi: -60, reliability: 1.0 },
    { sensor: { lat: 52.1317, lon: -122.1421 }, rssi: -72, reliability: 0.5 },
  ];
  const est = WorldmapEstimator.estimateWeightedRssiCentroid(obs, null);
  assert.equal(est.method, 'weighted-rssi-centroid');
  assert.equal(est.sensor_count, 2);
  assert.ok(Math.abs(est.point.lat - (20 * 52.1318 + 52.1317) / 21) < 1e-9);
  assert.ok(Math.abs(est.point.lon - (20 * -122.1422 + -122.1421) / 21) < 1e-9);
  // confidence = clamp(0.32 + 12/22 + 0.75*0.25) = clamp(1.053) = 0.99.
  assert.equal(est.confidence, 0.99);
  // Single observation: spread 0, avgRel 1 -> 0.32 + 0 + 0.25.
  const one = WorldmapEstimator.estimateWeightedRssiCentroid(
    [{ sensor: { lat: 52.1318, lon: -122.1422 }, rssi: -60, reliability: 1.0 }],
    null,
  );
  assert.equal(one.confidence, 0.57);
  // Empty -> null, like ARC-Core.
  assert.equal(WorldmapEstimator.estimateWeightedRssiCentroid([], null), null);
  // ARC-Core shape ({sensor_lat, sensor_lng}) works too.
  const arcShape = WorldmapEstimator.estimateWeightedRssiCentroid(
    [{ sensor_lat: 52.1318, sensor_lng: -122.1422, rssi: -60, reliability: 1.0 }],
    null,
  );
  assert.equal(arcShape.point.lat, 52.1318);
  // Structure clamp: sensors far outside Pine House pull the
  // point out; with the structure supplied it box-clamps in.
  const far = WorldmapEstimator.estimateWeightedRssiCentroid(
    [{ sensor: { lat: 52.14, lon: -122.15 }, rssi: -60, reliability: 1.0 }],
    { polygon: PINE },
  );
  const bounds = WorldmapGeo.boundsFromPolygon(PINE);
  assert.ok(far.point.lat >= bounds.minLat && far.point.lat <= bounds.maxLat);
  assert.ok(far.point.lon >= bounds.minLon && far.point.lon <= bounds.maxLon);
});

test('geofence hits: inside the Pine House perimeter, none outside', () => {
  const centre = WorldmapGeo.centroid(PINE);
  const hits = WorldmapContinuum.continuumGeofenceHits(centre);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'Pine House Perimeter');
  assert.equal(hits[0].severity, 5);
  assert.equal(hits[0].geofence_type, 'structure');
  assert.equal(WorldmapContinuum.continuumGeofenceHits({ lat: 52.13, lon: -122.14 }).length, 0);
  const geo = WorldmapContinuum.continuumGeoFor(centre);
  assert.equal(geo.structureId, 'str-pine-house');
  assert.equal(geo.zone, 'Center-Core');
  assert.equal(geo.geofenceHits.length, 1);
  const outside = WorldmapContinuum.continuumGeoFor({ lat: 52.13, lon: -122.14 });
  assert.equal(outside.structureId, null);
  assert.equal(outside.zone, null);
  assert.equal(outside.geofenceHits.length, 0);
});

test('heatmap grid matches ARC-Core get_heatmap semantics', () => {
  const structure = WorldmapContinuum.CONTINUUM_STRUCTURES[0];
  const tracks = [
    { lat: 52.1318, lon: -122.1422, confidence: 0.9 },
    { lat: 52.1318, lon: -122.1422, confidence: 0.7 },
    { lat: 52.1317, lon: -122.1421, confidence: 0.8 },
    { lat: 52.13, lon: -122.14, confidence: 0.5 }, // outside: excluded
  ];
  const grid = WorldmapContinuum.continuumHeatmap(structure, tracks, 4);
  assert.equal(grid.structure_id, 'str-pine-house');
  assert.equal(grid.grid_size, 4);
  assert.equal(grid.cells.reduce((a, c) => a + c.count, 0), 3);
  grid.cells.forEach((cell) => {
    assert.ok(WorldmapGeo.pointInPolygon(cell.center, PINE), 'cell centre inside polygon');
    assert.ok(cell.count >= 0);
  });
  const busy = grid.cells.find((c) => c.count === 2);
  assert.ok(busy, 'two tracks share a cell');
  assert.equal(busy.mean_confidence, 0.8);
  // Grid size clamps to ARC-Core's [2, 64].
  assert.equal(WorldmapContinuum.continuumHeatmap(structure, tracks, 500).grid_size, 64);
  assert.equal(WorldmapContinuum.continuumHeatmap(structure, tracks, 1).grid_size, 2);
});

test('candidate cloud stays inside the structure and shrinks with confidence', () => {
  const structure = WorldmapContinuum.CONTINUUM_STRUCTURES[0];
  const centre = WorldmapGeo.centroid(PINE);
  const low = WorldmapContinuum.arcCandidateCloud(structure, centre, 0.3, 16);
  const high = WorldmapContinuum.arcCandidateCloud(structure, centre, 0.9, 16);
  assert.equal(low.length, 16);
  assert.equal(high.length, 16);
  low.concat(high).forEach((p) => {
    assert.ok(WorldmapGeo.pointInPolygon(p, PINE), 'cloud point inside polygon');
  });
  const maxDist = (cloud) => Math.max(...cloud.map((p) => WorldmapGeo.distanceMeters(centre, p)));
  assert.ok(maxDist(high) < maxDist(low), 'higher confidence -> tighter cloud');
  assert.equal(WorldmapContinuum.arcCandidateCloud(null, centre, 0.5, 16).length, 0);
});

test('ARC calibration profile maps to the plugin profile and threads in', () => {
  const mapped = WorldmapContinuum.arcCalibrationToProfile({ path_loss: 2.2, noise_db: 3.5, smoothing: 0.65 });
  assert.equal(mapped.n, 2.2);
  assert.equal(mapped.noise, 3.5);
  assert.equal(mapped.smooth, 0.65);
  assert.equal(mapped.attenuation, 1.0);
  const prof = WorldmapPathloss.CALIBRATION['arc-default'];
  assert.equal(prof.n, 2.2);
  assert.equal(prof.noise, 3.5);
  assert.equal(prof.smooth, 0.65);
  // The exponent threads into the inverse model: -62 dBm at 1 m,
  // n=2.2 -> -84 dBm at 10 m.
  assert.ok(Math.abs(WorldmapPathloss.distanceFromRssi(-84, 'arc-default') - 10) < 1e-9);
  assert.equal(WorldmapPathloss.pathLossExponentFor('arc-default'), 2.2);
});

test('evidence pack carries zone and geofence hits', () => {
  const pack = WorldmapEvidence.buildEvidencePack({
    fix: { point: { lat: 52.1318, lon: -122.1422 }, confidence: 0.9 },
    observations: [{ sensorId: 's1-sn1', rssi: -60 }],
    calibration: { noise: 3.5, attenuation: 1.0, name: 'ARC-Core Default' },
    method: 'weighted-rssi-centroid',
    filterState: { type: 'kalman', innovationM: 0.5 },
    zone: 'Center-Core',
    geofenceHits: [{ geofence_id: 'g1', name: 'Pine House Perimeter', severity: 5, geofence_type: 'structure' }],
  });
  assert.equal(pack.method, 'weighted-rssi-centroid');
  assert.equal(pack.zone, 'Center-Core');
  assert.equal(pack.geofenceHits.length, 1);
  assert.equal(pack.geofenceHits[0].severity, 5);
  // Defaults when no continuum data: null zone, empty hits.
  const bare = WorldmapEvidence.buildEvidencePack({
    fix: { point: { lat: 52.13, lon: -122.14 }, confidence: 0.9 },
    method: 'gps',
  });
  assert.equal(bare.zone, null);
  assert.equal(bare.geofenceHits.length, 0);
});

test('regression: weighted + multilateration estimators still estimate', () => {
  const structure = WorldmapLab.DEFAULT_STRUCTURE;
  const sensors = WorldmapLab.buildSensorsForStructure(structure);
  assert.equal(sensors.length, 5);
  const rnd = WorldmapGeo.randomSeededInt(7);
  const truth = WorldmapGeo.seededPointInPolygon(structure.polygon, 42);
  const obs = WorldmapLab.makeObservations(truth, sensors, 1, 'balanced', rnd);
  const weighted = WorldmapEstimator.estimateFromObservations(obs, structure, null, 1, {});
  assert.ok(weighted && Number.isFinite(weighted.point.lat));
  assert.equal(weighted.method, 'weighted');
  const multi = WorldmapEstimator.multilaterate(
    obs.map((o) => ({ sensor: o.sensor, sensorId: o.sensor.id, rssi: o.rssi })),
    sensors,
    { structure },
  );
  assert.ok(multi && Number.isFinite(multi.point.lat));
  assert.equal(multi.method, 'multilateration');
  assert.ok(WorldmapGeo.distanceMeters(truth, multi.point) < 40, 'multilateration within 40 m');
});

test('Accuracy Lab dispatches the ARC-Core centroid method', () => {
  const report = WorldmapLab.runAccuracyLab({ frames: 20, seed: 101, method: 'weighted-rssi-centroid' });
  assert.equal(report.method, 'weighted-rssi-centroid');
  assert.equal(report.frames, 20);
  assert.ok(Number.isFinite(report.rmse) && report.rmse >= 0 && report.rmse < 100);
  assert.ok(report.p50 >= 0 && report.p95 >= report.p50);
});
