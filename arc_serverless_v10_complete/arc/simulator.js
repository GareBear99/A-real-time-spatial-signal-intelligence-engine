/**
 * ARC v10 — Offline Worldmap plugin: simulator.
 *
 * A test generator, not a fake demo (plan step 4). A seeded
 * truth path (a walk around the centre) is interpolated step by
 * step, and observations are computed FROM the truth through the
 * path-loss model with per-sensor noise — so the estimator can
 * be tested against it, and a run is reproducible: the same seed
 * produces the same observation sequence.
 *
 * Emits bus 'signal' events shaped
 *   {device, sensorId, rssi, time, simulated:true}
 * — one per sensor per tick — plus the truth is readable via
 * WorldmapSimulator.getTruth(device) for lab scoring.
 *
 * Keeps the old startSim()/stopSim() names and the
 * simulatorIntervalMs / devices globals the page uses.
 * startSim() with no arguments runs the defaults (seed 101,
 * the centre loop, the stored/auto-placed sensors).
 */

let timer = null;
let devices = ['phone1', 'phone2'];
/* Interval is a setting in the plugin (arc/settings.js
 * simulatorIntervalMs, default 600) — the page sets this
 * before starting the simulator. */
let simulatorIntervalMs = 600;

const SIM_DEFAULT_SEED = 101;
const TICKS_PER_SEGMENT = 20;

/** Default truth path: a small loop around the Williams Lake centre. */
const SIM_DEFAULT_WAYPOINTS = [
  { lat: 52.1314, lon: -122.1414 },
  { lat: 52.1314, lon: -122.1406 },
  { lat: 52.1306, lon: -122.1406 },
  { lat: 52.1306, lon: -122.1414 },
];

let simSeed = SIM_DEFAULT_SEED;
let simRng = null;
let simWaypoints = SIM_DEFAULT_WAYPOINTS;
let simSensors = [];
let simStep = 0;
let simRunning = false;
let simTruth = {};
let simProfileKey = 'balanced';

function simGeo() {
  return typeof WorldmapGeo !== 'undefined' ? WorldmapGeo : null;
}

function simPathloss() {
  return typeof WorldmapPathloss !== 'undefined' ? WorldmapPathloss : null;
}

/** Mulberry32 fallback when geo.js is not loaded (same algorithm). */
function fallbackSeeded(seed) {
  let t = Math.floor(seed * 1e6) ^ 0x9e3779b9;
  return function () {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Haversine fallback (metres) when geo.js is not loaded. */
function fallbackDistanceMeters(a, b) {
  const R = 6371000;
  const tr = Math.PI / 180;
  const dLat = (b.lat - a.lat) * tr;
  const dLon = (b.lon - a.lon) * tr;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * tr) * Math.cos(b.lat * tr) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Forward model fallback: -62 dBm at 1 m, 20*log10(d), uniform noise. */
function fallbackRssi(meters, noiseDb, attenuation, rnd) {
  const d = Math.max(1, meters * (attenuation || 1));
  return -30 - (32 + 20 * Math.log10(d)) + (rnd() - 0.5) * 2 * (noiseDb || 0);
}

function defaultSimSensors() {
  if (typeof WorldmapSensors !== 'undefined' && WorldmapSensors.SensorStore) {
    const stored = WorldmapSensors.SensorStore.list();
    if (stored.length) return stored;
    return WorldmapSensors.SensorStore.autoPlace();
  }
  if (typeof WorldmapLab !== 'undefined' && WorldmapLab.buildSensorsForStructure) {
    return WorldmapLab.buildSensorsForStructure(WorldmapLab.DEFAULT_STRUCTURE);
  }
  // Last resort: deterministic ring around the centre.
  return [0, 1, 2, 3, 4].map((i) => {
    const angle = (Math.PI * 2 * i) / 5;
    return {
      id: 's1-sn' + (i + 1),
      lat: 52.131 + Math.sin(angle) * 0.0004,
      lon: -122.141 + Math.cos(angle) * 0.0004,
      floor: 1,
      reliability: 0.86 - i * 0.04,
      history: [],
    };
  });
}

/** Truth position for a device at the current step (closed loop). */
function truthForStep(deviceIndex) {
  const waypoints = simWaypoints;
  const nSeg = waypoints.length;
  const cycle = (simStep + deviceIndex * 10) % (nSeg * TICKS_PER_SEGMENT);
  const seg = Math.floor(cycle / TICKS_PER_SEGMENT);
  const t = (cycle % TICKS_PER_SEGMENT) / TICKS_PER_SEGMENT;
  const g = simGeo();
  const a = waypoints[seg];
  const b = waypoints[(seg + 1) % nSeg];
  if (g) return g.lerpPoint(a, b, t);
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

/** One tick: one observation per sensor per device, from the truth. */
function simTick() {
  if (!simRng) return 0;
  const g = simGeo();
  const pl = simPathloss();
  const profile = pl ? pl.resolveProfile(simProfileKey) : { noise: 3.0, attenuation: 1.0 };
  let emitted = 0;
  devices.forEach((deviceId, deviceIndex) => {
    const truth = truthForStep(deviceIndex);
    simTruth[deviceId] = truth;
    simSensors.forEach((sensor) => {
      const reliability = pl ? pl.sensorReliability(sensor) : sensor.reliability || 0.86;
      const d = (g ? g.distanceMeters(truth, sensor) : fallbackDistanceMeters(truth, sensor)) * 1;
      const noiseDb = profile.noise * (1.05 - reliability * 0.4);
      const rssi = pl
        ? pl.rssiFromDistanceMeters(d, noiseDb, profile.attenuation, simRng)
        : fallbackRssi(d, noiseDb, profile.attenuation, simRng);
      bus.emit('signal', {
        device: deviceId,
        sensorId: sensor.id,
        rssi,
        time: simStep,
        simulated: true,
      });
      emitted += 1;
    });
  });
  simStep += 1;
  return emitted;
}

/**
 * Start the simulator.
 * options: {seed=101, waypoints, sensors, profile='balanced',
 *   devices} — all optional; defaults work with zero config.
 */
function startSim(options) {
  const opts = options || {};
  if (timer) stopSim();
  simSeed = typeof opts.seed === 'number' ? opts.seed : SIM_DEFAULT_SEED;
  const g = simGeo();
  simRng = g ? g.seeded(simSeed) : fallbackSeeded(simSeed);
  simWaypoints =
    Array.isArray(opts.waypoints) && opts.waypoints.length >= 2 ? opts.waypoints : SIM_DEFAULT_WAYPOINTS;
  simSensors =
    Array.isArray(opts.sensors) && opts.sensors.length ? opts.sensors : defaultSimSensors();
  if (Array.isArray(opts.devices) && opts.devices.length) devices = opts.devices.slice();
  if (typeof opts.profile === 'string') simProfileKey = opts.profile;
  simStep = 0;
  simTruth = {};
  simRunning = true;
  timer = setInterval(simTick, simulatorIntervalMs);
  return true;
}

function stopSim() {
  if (timer) clearInterval(timer);
  timer = null;
  simRunning = false;
}

const WorldmapSimulator = {
  startSim,
  stopSim,
  step: simTick,
  getTruth(deviceId) {
    return simTruth[deviceId] ? { ...simTruth[deviceId] } : null;
  },
  getSensors() {
    return simSensors.map((s) => ({ ...s }));
  },
  getStep() {
    return simStep;
  },
  isRunning() {
    return simRunning;
  },
  SIM_DEFAULT_WAYPOINTS,
};

if (typeof window !== 'undefined') window.WorldmapSimulator = WorldmapSimulator;
