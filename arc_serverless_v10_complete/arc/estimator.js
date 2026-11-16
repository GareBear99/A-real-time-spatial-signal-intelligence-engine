/**
 * ARC v10 — Offline Worldmap plugin: estimator.
 *
 * Two stages (plan steps 1a + 1b):
 *   1a. estimateFromObservations — v8.9's RSSI-weighted estimator,
 *       ported verbatim in behaviour: top-4 sensors by RSSI, weight
 *       10^((rssi+100)/12) * reliability / floorPenalty, smoothing
 *       against the previous fix, clamp to the structure polygon,
 *       confidence + candidate cloud.
 *   1b. multilaterate — least-squares multilateration: each RSSI
 *       becomes a distance through the log-distance path-loss
 *       model, then a Gauss-Newton solve in local metres finds the
 *       position best fitting all the distance circles. Needs >=3
 *       anchors with known positions; falls back to the weighted
 *       estimator below that.
 *
 * Both return the same shape:
 *   {point:{lat,lon}, confidence, method, cloud?, residualM?}
 *
 * Load after geo.js and pathloss.js. No network, no dependencies.
 */

let currentProfileKey = 'balanced';

function getProfile() {
  return currentProfileKey;
}

function setProfile(key) {
  if (typeof WorldmapPathloss !== 'undefined' && WorldmapPathloss.CALIBRATION[key]) {
    currentProfileKey = key;
    return true;
  }
  return false;
}

function profileOf(options) {
  if (options && options.profile) return options.profile;
  return currentProfileKey;
}

function normalizeWeights(items) {
  const total = items.reduce((a, b) => a + (b.weight || 0), 0) || 1;
  return items.map((x) => ({ ...x, weight: (x.weight || 0) / total }));
}

/** Deterministic candidate cloud around a point (v8: candidateCloud). */
function candidateCloud(point, count, spreadMeters) {
  const cloud = [];
  if (!point || !count) return cloud;
  const p = WorldmapGeo.asPoint(point);
  const latScale = 1 / 111111;
  const lngScale = 1 / (111111 * Math.cos((p.lat * Math.PI) / 180) || 1);
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count;
    const radius = (0.35 + (i % 5) / 6) * spreadMeters;
    cloud.push({
      lat: p.lat + Math.sin(angle) * radius * latScale,
      lon: p.lon + Math.cos(angle) * radius * lngScale,
    });
  }
  return cloud;
}

/** Structure may be a polygon array, {polygon}, or null. */
function structurePolygon(structure) {
  if (!structure) return null;
  if (Array.isArray(structure)) return structure;
  if (Array.isArray(structure.polygon)) return structure.polygon;
  return null;
}

function structureLevels(structure) {
  if (structure && typeof structure.levels === 'number') return Math.max(1, structure.levels);
  return 1;
}

/**
 * (1a) v8's weighted estimator.
 * observations: [{sensor:{lat,lon|lng,floor,reliability,history},
 *   rssi, reliability?, floorPenalty?}]
 * structure: polygon / {polygon, levels} / null (no clamping then).
 * previous: {lat,lon} fix to smooth against, or null.
 * truthFloor: floor the device is believed to be on (default 1).
 * options: {profile, cloudDensity}
 */
function estimateFromObservations(observations, structure, previous, truthFloor, options) {
  const opts = options || {};
  if (!observations || !observations.length) return null;
  const floor = truthFloor || 1;
  const profile = WorldmapPathloss.resolveProfile(profileOf(opts));
  const sorted = [...observations].sort((a, b) => b.rssi - a.rssi);
  const top = sorted.slice(0, Math.min(4, sorted.length));
  const weighted = normalizeWeights(
    top.map((obs) => ({
      obs,
      weight:
        Math.pow(10, (obs.rssi + 100) / 12) *
        (obs.reliability || WorldmapPathloss.sensorReliability(obs.sensor) || 0.8) /
        (obs.floorPenalty || 1),
    })),
  );
  let lat = 0;
  let lon = 0;
  let inferredFloor = 0;
  let spreadScore = 0;
  for (const item of weighted) {
    const s = WorldmapGeo.asPoint(item.obs.sensor);
    lat += s.lat * item.weight;
    lon += s.lon * item.weight;
    inferredFloor += (item.obs.sensor.floor || 1) * item.weight;
    spreadScore += (1 - item.weight) * 0.2;
  }
  let point = { lat, lon };
  let clusterSpread = 0;
  if (top.length > 1) {
    const pairs = [];
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        pairs.push(WorldmapGeo.distanceMeters(top[i].sensor, top[j].sensor));
      }
    }
    clusterSpread = pairs.reduce((a, b) => a + b, 0) / pairs.length;
  }
  if (previous) point = WorldmapGeo.lerpPoint(previous, point, 1 - profile.smooth);
  const polygon = structurePolygon(structure);
  if (polygon) {
    const bounds = WorldmapGeo.boundsFromPolygon(polygon);
    if (!WorldmapGeo.pointInPolygon(point, polygon)) {
      point = WorldmapGeo.clampPointToBounds(point, bounds);
    }
  }
  const spread = Math.max(0, (sorted[0] ? sorted[0].rssi : 0) - (sorted[1] ? sorted[1].rssi : sorted[0] ? sorted[0].rssi : 0));
  const floorAgreement = Math.max(0, 1 - Math.abs((inferredFloor || 1) - floor) * 0.25);
  const confidence = Math.max(
    0.12,
    Math.min(
      0.995,
      0.28 +
        spread / 28 +
        floorAgreement * 0.14 +
        (clusterSpread ? Math.max(0, 1 - clusterSpread / 38) / 4 : 0) -
        spreadScore,
    ),
  );
  return {
    point,
    confidence,
    method: 'weighted',
    clusterSpread,
    floor: Math.max(1, Math.min(structureLevels(structure), Math.round(inferredFloor || floor))),
    cloud: candidateCloud(point, Number(opts.cloudDensity || 0), Math.max(4, clusterSpread * 0.18 + (1 - confidence) * 18)),
  };
}

/**
 * Resolve a raw observation to an anchor with a known position.
 * Accepts {sensorId, rssi} + a sensors list, or {sensor:{...}, rssi}.
 */
function resolveAnchors(observations, sensors) {
  const byId = {};
  (sensors || []).forEach((s) => {
    if (s && s.id !== undefined) byId[s.id] = s;
  });
  const anchors = [];
  (observations || []).forEach((obs) => {
    if (!obs || typeof obs.rssi !== 'number') return;
    const sensor = obs.sensor || byId[obs.sensorId];
    if (!sensor) return;
    const p = WorldmapGeo.asPoint(sensor);
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
    anchors.push({ sensor, point: p, rssi: obs.rssi });
  });
  return anchors;
}

/**
 * (1b) Least-squares multilateration (Gauss-Newton in local metres).
 * observations: [{sensorId, rssi}] or [{sensor, rssi}].
 * sensors: [{id, lat, lon, floor?}] — known anchor positions.
 * options: {profile, structure, previous, cloudDensity}
 * Returns null only when no anchor can be resolved at all.
 * With <3 anchors it falls back to the weighted estimator.
 */
function multilaterate(observations, sensors, options) {
  const opts = options || {};
  const profile = WorldmapPathloss.resolveProfile(profileOf(opts));
  const anchors = resolveAnchors(observations, sensors);
  if (!anchors.length) return null;

  if (anchors.length < 3) {
    const weightedObs = anchors.map((a) => ({
      sensor: a.sensor,
      rssi: a.rssi,
      reliability: WorldmapPathloss.sensorReliability(a.sensor),
      floorPenalty: 1,
    }));
    const est = estimateFromObservations(weightedObs, opts.structure || null, opts.previous || null, 1, opts);
    if (est) est.method = 'weighted';
    return est;
  }

  const withDist = anchors.map((a) => ({
    ...a,
    distanceM: WorldmapPathloss.distanceFromRssi(a.rssi, profile),
  }));
  const ref = WorldmapGeo.centroid(withDist.map((a) => a.point));
  const local = withDist.map((a) => ({
    ...a,
    xy: WorldmapGeo.toLocalMeters(a.point.lat, a.point.lon, ref.lat, ref.lon),
  }));

  // Initial guess: inverse-distance-weighted centroid of anchors.
  let wSum = 0;
  let gx = 0;
  let gy = 0;
  local.forEach((a) => {
    const w = 1 / (a.distanceM * a.distanceM + 1);
    wSum += w;
    gx += a.xy.x * w;
    gy += a.xy.y * w;
  });
  let x = gx / wSum;
  let y = gy / wSum;

  // Gauss-Newton on residuals |p - a_i| - d_i, with light damping.
  for (let iter = 0; iter < 25; iter++) {
    let jtj00 = 0;
    let jtj01 = 0;
    let jtj11 = 0;
    let jtr0 = 0;
    let jtr1 = 0;
    local.forEach((a) => {
      const dx = x - a.xy.x;
      const dy = y - a.xy.y;
      const pred = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      const r = pred - a.distanceM;
      const jx = dx / pred;
      const jy = dy / pred;
      jtj00 += jx * jx;
      jtj01 += jx * jy;
      jtj11 += jy * jy;
      jtr0 += jx * r;
      jtr1 += jy * r;
    });
    const lambda = 1e-6;
    jtj00 += lambda;
    jtj11 += lambda;
    const det = jtj00 * jtj11 - jtj01 * jtj01 || 1e-12;
    let stepX = (-jtj11 * jtr0 + jtj01 * jtr1) / det;
    let stepY = (jtj01 * jtr0 - jtj00 * jtr1) / det;
    // Clamp wild steps (bad geometry / noisy RSSI).
    const stepLen = Math.sqrt(stepX * stepX + stepY * stepY);
    const maxStep = 50;
    if (stepLen > maxStep) {
      stepX = (stepX / stepLen) * maxStep;
      stepY = (stepY / stepLen) * maxStep;
    }
    x += stepX;
    y += stepY;
    if (Math.sqrt(stepX * stepX + stepY * stepY) < 1e-4) break;
  }

  let point = WorldmapGeo.fromLocalMeters(x, y, ref);
  const polygon = structurePolygon(opts.structure);
  if (polygon) {
    const bounds = WorldmapGeo.boundsFromPolygon(polygon);
    if (!WorldmapGeo.pointInPolygon(point, polygon)) {
      point = WorldmapGeo.clampPointToBounds(point, bounds);
      const clamped = WorldmapGeo.toLocalMeters(point.lat, point.lon, ref.lat, ref.lon);
      x = clamped.x;
      y = clamped.y;
    }
  }
  if (opts.previous) {
    point = WorldmapGeo.lerpPoint(opts.previous, point, 1 - profile.smooth);
  }

  let ss = 0;
  local.forEach((a) => {
    const dx = x - a.xy.x;
    const dy = y - a.xy.y;
    const r = Math.sqrt(dx * dx + dy * dy) - a.distanceM;
    ss += r * r;
  });
  const residualM = Math.sqrt(ss / local.length);
  // Confidence falls as the circles disagree; >=4 anchors helps.
  const confidence = Math.max(
    0.12,
    Math.min(0.99, 0.97 - residualM / 25 - (local.length < 4 ? 0.05 : 0)),
  );
  return {
    point,
    confidence,
    method: 'multilateration',
    residualM,
    anchors: local.length,
    cloud: candidateCloud(point, Number(opts.cloudDensity || 0), Math.max(4, residualM * 1.5 + (1 - confidence) * 18)),
  };
}

const WorldmapEstimator = {
  getProfile,
  setProfile,
  estimateFromObservations,
  multilaterate,
  candidateCloud,
  resolveAnchors,
};

if (typeof window !== 'undefined') window.WorldmapEstimator = WorldmapEstimator;
