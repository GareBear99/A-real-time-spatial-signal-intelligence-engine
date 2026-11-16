/**
 * ARC v10 — Offline Worldmap plugin: path loss.
 *
 * The forward model ported from the v8.9 bundle:
 *   RSSI(d) = tx - (32 + 20*log10(d * attenuation)) + noise
 *   tx = -30 dBm, so RSSI at 1 m with no attenuation is -62 dBm.
 *
 * The inverse (distanceFromRssi) is the log-distance model the
 * multilateration solver inverts:
 *   d = 10^((rssiAt1m - rssi) / (10*n)) / attenuation
 * with n = 2 (free space) and rssiAt1m = -62 by default, both
 * overridable per calibration profile so the calibration wizard
 * can tune them.
 *
 * Load after geo.js. No network, no dependencies.
 */

/** Calibration profiles — same numbers as the v8.9 bundle. */
const CALIBRATION = {
  balanced: { name: 'Balanced', noise: 3.0, attenuation: 1.0, decay: 0.82, smooth: 0.62 },
  urban: { name: 'Urban Dense', noise: 4.8, attenuation: 1.18, decay: 0.78, smooth: 0.72 },
  residential: { name: 'Residential', noise: 2.0, attenuation: 0.92, decay: 0.86, smooth: 0.56 },
  interference: { name: 'High Interference', noise: 6.5, attenuation: 1.28, decay: 0.74, smooth: 0.78 },
};

/** Resolve a profile key ('balanced') or a profile object. */
function resolveProfile(profile) {
  if (!profile) return CALIBRATION.balanced;
  if (typeof profile === 'string') return CALIBRATION[profile] || CALIBRATION.balanced;
  return profile;
}

/**
 * Forward model (v8: rssiFromDistanceMeters).
 * meters: true distance; noiseDb: uniform noise half-width in dB;
 * attenuation: multiplicative distance factor (walls, clutter).
 * rnd: optional () => [0,1) — pass a seeded RNG for reproducible
 * runs; defaults to Math.random like v8.
 */
function rssiFromDistanceMeters(meters, noiseDb, attenuation, rnd) {
  const d = Math.max(1, meters * (attenuation || 1));
  const pathLoss = 32 + 20 * Math.log10(d);
  const tx = -30;
  const rand = typeof rnd === 'function' ? rnd : Math.random;
  const noise = (rand() - 0.5) * 2 * (noiseDb || 0);
  return tx - pathLoss + noise;
}

/** RSSI at 1 m for a profile: -30 tx minus 32 dB free-space loss. */
function rssiAt1mFor(profile) {
  const p = resolveProfile(profile);
  if (typeof p.rssiAt1m === 'number') return p.rssiAt1m;
  return -62;
}

/** Path-loss exponent for a profile (2 = free space). */
function pathLossExponentFor(profile) {
  const p = resolveProfile(profile);
  if (typeof p.n === 'number') return p.n;
  return 2;
}

/**
 * Inverse log-distance model: RSSI -> distance in metres.
 * Exact inverse of rssiFromDistanceMeters with zero noise.
 */
function distanceFromRssi(rssi, profile) {
  const p = resolveProfile(profile);
  const n = pathLossExponentFor(p);
  const rssiAt1m = rssiAt1mFor(p);
  const attenuation = p.attenuation || 1;
  const d = Math.pow(10, (rssiAt1m - rssi) / (10 * n)) / attenuation;
  return Math.max(0.5, d);
}

/**
 * A sensor's weight in the estimator, from its recent error
 * history (v8: sensorReliability). No history -> the sensor's
 * configured reliability, default 0.86. Clamped [0.45, 0.99].
 */
function sensorReliability(sensor) {
  const history = (sensor && sensor.history) || [];
  if (!history.length) return sensor && typeof sensor.reliability === 'number' ? sensor.reliability : 0.86;
  const avgAbs = history.reduce((a, b) => a + Math.abs(b.error || 0), 0) / history.length;
  return Math.max(0.45, Math.min(0.99, 0.98 - avgAbs / 18));
}

/** Floor mismatch penalty (v8: floorPenalty). */
function floorPenalty(sensorFloor, truthFloor) {
  return 1 + Math.abs((sensorFloor || 1) - (truthFloor || 1)) * 0.28;
}

const WorldmapPathloss = {
  CALIBRATION,
  resolveProfile,
  rssiFromDistanceMeters,
  distanceFromRssi,
  rssiAt1mFor,
  pathLossExponentFor,
  sensorReliability,
  floorPenalty,
};

if (typeof window !== 'undefined') window.WorldmapPathloss = WorldmapPathloss;
