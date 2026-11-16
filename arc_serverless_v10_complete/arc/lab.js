/**
 * ARC v10 — Offline Worldmap plugin: Accuracy Lab + calibration wizard.
 *
 * Step 0 of the plan: measure first. runAccuracyLab is the v8.9
 * seeded Monte Carlo ported to pure functions — random truth
 * points inside the structure polygon (seeded), observations
 * through the forward model, estimate, error =
 * distanceMeters(truth, estimate). Returns RMSE / P50 / P95 /
 * mean confidence. runCalibrationWizard derives a tuned
 * noise/attenuation profile from observation history, same
 * formulas as v8.
 *
 * Defaults work with zero configuration: the Pine House demo
 * structure from v8 and its 5 seeded sensors. Attach as
 * window.WorldmapLab. Load after geo.js, pathloss.js,
 * estimator.js.
 */

/** v8 demo structure (Pine House) — the default lab structure. */
const DEFAULT_STRUCTURE = {
  id: 's1',
  name: 'Pine House',
  levels: 1,
  polygon: [
    [52.13188, -122.14235],
    [52.13188, -122.14203],
    [52.13168, -122.14203],
    [52.13168, -122.14235],
  ],
};

/** v8's buildSensorsForStructure: 4 seeded points + centre anchor. */
function buildSensorsForStructure(structure) {
  const polygon = Array.isArray(structure) ? structure : structure.polygon;
  const id = (structure && structure.id) || 's1';
  const levels = Math.max(1, Number((structure && structure.levels) || 1));
  const c = WorldmapGeo.centroid(polygon);
  const pts = [
    WorldmapGeo.seededPointInPolygon(polygon, 11),
    WorldmapGeo.seededPointInPolygon(polygon, 27),
    WorldmapGeo.seededPointInPolygon(polygon, 53),
    WorldmapGeo.seededPointInPolygon(polygon, 81),
    c,
  ];
  return pts.map((p, i) => ({
    id: `${id}-sn${i + 1}`,
    lat: p.lat,
    lon: p.lon,
    type: i === 4 ? 'center-anchor' : 'anchor',
    floor: 1 + (i % levels),
    reliability: 0.86 - i * 0.04,
    history: [],
  }));
}

/** Forward model (v8: makeObservations), deterministic when rnd is given. */
function makeObservations(truth, sensors, truthFloor, profile, rnd) {
  const prof = WorldmapPathloss.resolveProfile(profile);
  return sensors.map((sensor) => {
    const reliability = WorldmapPathloss.sensorReliability(sensor);
    const floorFactor = WorldmapPathloss.floorPenalty(sensor.floor, truthFloor);
    const d = WorldmapGeo.distanceMeters(truth, sensor) * floorFactor;
    const rssi = WorldmapPathloss.rssiFromDistanceMeters(
      d,
      prof.noise * (1.05 - reliability * 0.4),
      prof.attenuation,
      rnd,
    );
    return { sensor, rssi, reliability, floorPenalty: floorFactor };
  });
}

/**
 * Seeded Monte Carlo accuracy run (v8: runAccuracyLab).
 * options: {frames=120, seed=101, sensors, structure,
 *   estimator, method, profile}
 *   sensors: [{id,lat,lon,floor,reliability,history}] — default
 *     is the 5 seeded sensors for the structure.
 *   structure: {polygon, levels} or a polygon array — default
 *     Pine House.
 *   estimator: (observations, structure, previous, floor, opts)
 *     => {point, confidence} — default is estimateFromObservations.
 *   method: 'weighted' (default) or 'multilateration' — a
 *     shorthand for the estimator so the one-click check in
 *     the UI can pick the method without hand-wrapping the
 *     estimator (multilaterate takes (observations, sensors,
 *     options), not the lab's (observations, structure,
 *     previous, floor, opts) shape).
 * Returns {frames, seed, method, rmse, p50, p95, meanConfidence}.
 */
function runAccuracyLab(options) {
  const opts = options || {};
  const frames = Math.max(20, Math.min(500, Number(opts.frames) || 120));
  const seed = Math.max(1, Number(opts.seed) || 101);
  const structure = opts.structure || DEFAULT_STRUCTURE;
  const polygon = Array.isArray(structure) ? structure : structure.polygon;
  const levels = Math.max(1, Number((structure && structure.levels) || 1));
  const sensors = opts.sensors || buildSensorsForStructure(structure);
  const profile = opts.profile || 'balanced';
  const method = opts.method === 'multilateration' ? 'multilateration' : 'weighted';
  const estimator =
    opts.estimator ||
    (method === 'multilateration'
      ? (obs, struct, previous, floor, o) =>
          WorldmapEstimator.multilaterate(obs, sensors, {
            profile: (o && o.profile) || profile,
            structure: struct,
            previous,
          })
      : WorldmapEstimator.estimateFromObservations);
  const rnd = WorldmapGeo.randomSeededInt(seed);

  let previous = null;
  const errors = [];
  const confidences = [];
  for (let i = 0; i < frames; i++) {
    const truth = WorldmapGeo.seededPointInPolygon(polygon, rnd() * 999 + i + 1);
    const truthFloor = 1 + Math.floor(rnd() * levels);
    const observations = makeObservations(truth, sensors, truthFloor, profile, rnd);
    const est = estimator(observations, structure, previous, truthFloor, { profile });
    previous = (est && est.point) || previous;
    const error = est && est.point ? WorldmapGeo.distanceMeters(truth, est.point) : 999;
    errors.push(error);
    confidences.push((est && est.confidence) || 0);
  }
  const sorted = [...errors].sort((a, b) => a - b);
  const rmse = Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / errors.length);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1];
  return {
    frames,
    seed,
    method,
    rmse: Number(rmse.toFixed(2)),
    p50: Number(p50.toFixed(2)),
    p95: Number(p95.toFixed(2)),
    meanConfidence: Number((confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(3)),
  };
}

/**
 * Calibration wizard (v8: runCalibrationWizard), pure version.
 * observationHistory: [{confidence, topRssi, clusterSpread?}].
 * currentProfile: key or profile object. options: {spread, floor}.
 * Returns the tuned profile object (does NOT install it — the
 * caller decides; use WorldmapEstimator.setProfile to apply a
 * named profile, or store the tuned object as a custom profile).
 */
function runCalibrationWizard(observationHistory, currentProfile, options) {
  const opts = options || {};
  const profile = WorldmapPathloss.resolveProfile(currentProfile || 'balanced');
  const hist = Array.isArray(observationHistory) ? observationHistory : [];
  const conf = hist.length
    ? hist.reduce((a, b) => a + (b.confidence || 0), 0) / hist.length
    : 0.5;
  const avgTop = hist.length
    ? hist.reduce((a, b) => a + (typeof b.topRssi === 'number' ? b.topRssi : -75), 0) / hist.length
    : -72;
  const spread =
    typeof opts.spread === 'number'
      ? opts.spread
      : hist.length && typeof hist[0].clusterSpread === 'number'
        ? hist.reduce((a, b) => a + (b.clusterSpread || 0), 0) / hist.length
        : 12;
  const floor = typeof opts.floor === 'number' ? opts.floor : 1;
  const tunedNoise = Math.max(
    1.4,
    Math.min(7.5, profile.noise + (1 - conf) * 1.6 + Math.max(0, spread - 14) / 18),
  );
  const tunedAttn = Math.max(
    0.85,
    Math.min(1.4, profile.attenuation + (avgTop < -70 ? 0.08 : -0.03) + Math.max(0, floor - 1) * 0.03),
  );
  return {
    name: 'Wizard-Calibrated',
    noise: Number(tunedNoise.toFixed(2)),
    attenuation: Number(tunedAttn.toFixed(2)),
    decay: Number((profile.decay * 0.98).toFixed(2)),
    smooth: Number(Math.min(0.86, profile.smooth + 0.05).toFixed(2)),
  };
}

const WorldmapLab = {
  DEFAULT_STRUCTURE,
  buildSensorsForStructure,
  makeObservations,
  runAccuracyLab,
  runCalibrationWizard,
};

if (typeof window !== 'undefined') window.WorldmapLab = WorldmapLab;
