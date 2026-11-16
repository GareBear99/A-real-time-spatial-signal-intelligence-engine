/**
 * ARC v10 — Offline Worldmap plugin: triangulation.
 *
 * The bus 'signal' handler (plan steps 1 + 5). Two signal shapes:
 *   (a) GPS / direct fix {device, lat, lon, rssi?, time} — no
 *       sensorId: the location IS the fix. It still runs through
 *       the Kalman filter for smoothing (method 'gps') and a
 *       location appears immediately — each fix is already a
 *       position, so there is no 3-signal wait.
 *   (b) Sensor observation {device, sensorId, rssi, time,
 *       simulated?} — accumulated per device (latest reading per
 *       sensor). With >=3 anchored sensors with observations in
 *       the window the estimator runs multilateration, else the
 *       RSSI-weighted estimator; the fix is then Kalman-filtered
 *       and pushed to d.locations / d.path with its evidence.
 *       The estimator method comes from settings: 'multilateration',
 *       'weighted', or 'weighted-rssi-centroid' (ARC-Core's own
 *       estimator, exact port in arc/estimator.js).
 *
 * Every fix — GPS or estimated — is classified by the continuum
 * segment (arc/continuum.js, ARC-Core estimate_track): the
 * containing structure, its zone (Center-Core / North / South /
 * West / East), and any geofence hits. The classification rides
 * on the location (loc.zone / loc.geofenceHits) and in its
 * evidence pack; with the continuum layer off, locations carry
 * none of it, exactly as before.
 *
 * The old centroid path survives ONLY as the fallback when the
 * new engine files (geo/pathloss/estimator/filter) are not
 * loaded — the page keeps working until the coordinator wires
 * the script tags in. In that fallback a device still needs
 * >=3 signals before a location appears, as before.
 *
 * Defaults: 'balanced' profile, Kalman ON. No sensors or no
 * structure polygon degrades gracefully: GPS/direct fixes
 * still plot, and nothing clamps.
 */

function triangulate(signals) {
  if (signals.length < 3) return null;
  let lat = 0;
  let lon = 0;
  signals.slice(-3).forEach((s) => {
    lat += s.lat;
    lon += s.lon;
  });
  return { lat: lat / 3, lon: lon / 3 };
}

function engineAvailable() {
  return (
    typeof WorldmapGeo !== 'undefined' &&
    typeof WorldmapPathloss !== 'undefined' &&
    typeof WorldmapEstimator !== 'undefined'
  );
}

function filterAvailable() {
  return typeof WorldmapFilter !== 'undefined' && typeof WorldmapFilter.KalmanFilter2D === 'function';
}

/** Run a raw fix through the device's Kalman filter (local metres).
 *  The filter can be switched off from settings
 *  (worldmapUseFilter === false) — then the fix passes through. */
function kalmanSmooth(d, point, confidence) {
  if (typeof worldmapUseFilter !== 'undefined' && worldmapUseFilter === false) {
    return { point: { lat: point.lat, lon: point.lon }, innovationM: 0 };
  }
  if (!filterAvailable()) return { point, innovationM: 0 };
  const g = WorldmapGeo;
  if (!d._kfRef) {
    d._kfRef = { lat: point.lat, lon: point.lon };
    d._kf = new WorldmapFilter.KalmanFilter2D();
    d._kfLastWall = Date.now();
  }
  const now = Date.now();
  const dt = d._kfLastWall ? Math.min(5, Math.max(0.05, (now - d._kfLastWall) / 1000)) : 1;
  d._kfLastWall = now;
  const z = g.toLocalMeters(point.lat, point.lon, d._kfRef.lat, d._kfRef.lon);
  if (!d._kf.initialized) {
    d._kf.reset(z.x, z.y);
    return { point: { lat: point.lat, lon: point.lon }, innovationM: 0 };
  }
  d._kf.predict(dt);
  const filtered = d._kf.update(z, confidence);
  return {
    point: g.fromLocalMeters(filtered.x, filtered.y, d._kfRef),
    innovationM: d._kf.innovationM || 0,
  };
}

function structureForDevice(d) {
  if (typeof worldmapStructure !== 'undefined' && worldmapStructure) return worldmapStructure;
  // Continuum segment: once a device's last fix was inside a
  // seeded structure, that structure bounds the next estimate —
  // ARC-Core's estimate_track clamps to the structure bounds.
  // No previous fix inside a structure -> no structure, no
  // clamping, exactly as before.
  if (
    typeof WorldmapContinuum !== 'undefined' &&
    WorldmapContinuum.structureContaining &&
    d &&
    d._prevFix
  ) {
    try {
      return WorldmapContinuum.structureContaining(d._prevFix) || null;
    } catch (e) {
      return null;
    }
  }
  return null;
}

function calibrationForEvidence() {
  if (typeof WorldmapPathloss === 'undefined') return {};
  const key =
    typeof WorldmapEstimator !== 'undefined' && WorldmapEstimator.getProfile
      ? WorldmapEstimator.getProfile()
      : 'balanced';
  return WorldmapPathloss.resolveProfile(key) || {};
}

function buildFixEvidence(fix, observations, method, filterState, geo) {
  if (typeof WorldmapEvidence === 'undefined') return null;
  const profile = calibrationForEvidence();
  const obs = (observations || []).map((o) => {
    const entry = { sensorId: o.sensorId || (o.sensor && o.sensor.id) || null, rssi: o.rssi };
    if (typeof WorldmapPathloss !== 'undefined' && typeof o.rssi === 'number') {
      entry.distanceM = WorldmapPathloss.distanceFromRssi(o.rssi, profile);
    }
    if (o.sensor && typeof WorldmapPathloss !== 'undefined') {
      entry.reliability = WorldmapPathloss.sensorReliability(o.sensor);
    } else if (typeof o.reliability === 'number') {
      entry.reliability = o.reliability;
    }
    return entry;
  });
  return WorldmapEvidence.buildEvidencePack({
    fix,
    observations: obs,
    calibration: profile,
    method,
    filterState,
    zone: geo && geo.zone ? geo.zone : null,
    geofenceHits: geo && geo.geofenceHits ? geo.geofenceHits : [],
  });
}

/**
 * Continuum classification for one fix (ARC-Core
 * estimate_track, minus the estimator and the receipt):
 * the containing structure, its zone, and any geofence
 * hits. Null when the continuum module is absent or the
 * layer is switched off — locations then carry no zone,
 * exactly as before.
 */
function continuumGeoForPoint(point) {
  if (typeof worldmapShowContinuum !== 'undefined' && worldmapShowContinuum === false) return null;
  if (typeof WorldmapContinuum === 'undefined' || !WorldmapContinuum.continuumGeoFor) return null;
  try {
    return WorldmapContinuum.continuumGeoFor(point);
  } catch (e) {
    return null;
  }
}

function pushLocation(d, point, confidence, method, evidence, geo) {
  const loc = { lat: point.lat, lon: point.lon, confidence, method };
  if (evidence) loc.evidence = evidence;
  if (geo) {
    if (geo.zone) loc.zone = geo.zone;
    if (geo.structureId) loc.structureId = geo.structureId;
    if (geo.geofenceHits) loc.geofenceHits = geo.geofenceHits;
  }
  d.locations.push(loc);
  d.path.push({ lat: point.lat, lon: point.lon });
  d._prevFix = { lat: point.lat, lon: point.lon };
  if (geo) d._lastGeo = geo;
}

function handleGpsFix(d, sig) {
  const point = { lat: sig.lat, lon: sig.lon };
  const confidence = typeof sig.confidence === 'number' ? sig.confidence : 0.9;
  const smoothed = kalmanSmooth(d, point, confidence);
  // Imported tracks get a zone too (ARC-Core
  // import_track_points classifies the zone on import).
  const geo = continuumGeoForPoint(smoothed.point);
  const evidence = buildFixEvidence(
    { point: smoothed.point, confidence, method: 'gps' },
    [],
    'gps',
    { type: 'kalman', innovationM: smoothed.innovationM },
    geo,
  );
  pushLocation(d, smoothed.point, confidence, 'gps', evidence, geo);
}

function handleSensorObservation(d, sig) {
  if (!d._obs) d._obs = {};
  d._obs[sig.sensorId] = { sensorId: sig.sensorId, rssi: sig.rssi, time: sig.time };

  if (!engineAvailable()) return; // No engine yet — nothing to estimate from.
  const sensors =
    typeof WorldmapSensors !== 'undefined' && WorldmapSensors.SensorStore
      ? WorldmapSensors.SensorStore.list()
      : [];
  const observations = Object.values(d._obs);
  const anchored = observations.filter((o) =>
    sensors.some((s) => s.id === o.sensorId),
  );
  // The estimator needs >=3 anchored sensor observations.
  if (anchored.length < 3) return;

  const structure = structureForDevice(d);
  const method =
    typeof worldmapEstimatorMethod !== 'undefined' &&
    (worldmapEstimatorMethod === 'weighted' || worldmapEstimatorMethod === 'weighted-rssi-centroid')
      ? worldmapEstimatorMethod
      : 'multilateration';

  // Fingerprint mode: locate from the surveyed radio map
  // instead of ranging — only when a map is actually loaded.
  if (
    typeof WorldmapFingerprint !== 'undefined' &&
    WorldmapFingerprint.getMode &&
    WorldmapFingerprint.getMode() === 'fingerprint' &&
    WorldmapFingerprint.pointCount &&
    WorldmapFingerprint.pointCount() > 0
  ) {
    const vector = {};
    anchored.forEach((o) => {
      vector[o.sensorId] = o.rssi;
    });
    let located = null;
    try {
      located = WorldmapFingerprint.locate(vector);
    } catch (e) {
      located = null;
    }
    if (located && located.point) {
      const smoothed = kalmanSmooth(d, located.point, located.confidence);
      const geo = continuumGeoForPoint(smoothed.point);
      const evidence = buildFixEvidence(
        { point: smoothed.point, confidence: located.confidence, method: 'fingerprint' },
        anchored.map((o) => {
          const sensor = sensors.find((s) => s.id === o.sensorId);
          return { sensorId: o.sensorId, rssi: o.rssi, sensor };
        }),
        'fingerprint',
        { type: 'kalman', innovationM: smoothed.innovationM },
        geo,
      );
      pushLocation(d, smoothed.point, located.confidence, 'fingerprint', evidence, geo);
      return;
    }
    // No fingerprint match — fall through to ranging.
  }

  let est = null;
  if (method === 'weighted-rssi-centroid') {
    // ARC-Core's own estimator (exact port): exponential-RSSI
    // weights over ALL anchored observations, ARC-Core
    // confidence formula. Falls back to the plugin weighted
    // estimator if the port is not loaded.
    if (typeof WorldmapEstimator.estimateWeightedRssiCentroid === 'function') {
      const arcObs = anchored.map((o) => {
        const sensor = sensors.find((s) => s.id === o.sensorId);
        return {
          sensor,
          rssi: o.rssi,
          reliability: sensor ? WorldmapPathloss.sensorReliability(sensor) : 0.8,
        };
      });
      est = WorldmapEstimator.estimateWeightedRssiCentroid(arcObs, structure);
    }
    if (!est) {
      const weightedObs = anchored.map((o) => {
        const sensor = sensors.find((s) => s.id === o.sensorId);
        return {
          sensor,
          rssi: o.rssi,
          reliability: sensor ? WorldmapPathloss.sensorReliability(sensor) : 0.8,
          floorPenalty: 1,
        };
      });
      est = WorldmapEstimator.estimateFromObservations(weightedObs, structure, d._prevFix || null, 1, {});
    }
  } else if (method === 'weighted') {
    const weightedObs = anchored.map((o) => {
      const sensor = sensors.find((s) => s.id === o.sensorId);
      return {
        sensor,
        rssi: o.rssi,
        reliability: sensor ? WorldmapPathloss.sensorReliability(sensor) : 0.8,
        floorPenalty: 1,
      };
    });
    est = WorldmapEstimator.estimateFromObservations(weightedObs, structure, d._prevFix || null, 1, {});
  } else {
    est = WorldmapEstimator.multilaterate(anchored, sensors, {
      structure,
      previous: d._prevFix || null,
    });
  }
  if (!est || !est.point) return;

  const smoothed = kalmanSmooth(d, est.point, est.confidence);
  const geo = continuumGeoForPoint(smoothed.point);
  const evidence = buildFixEvidence(
    { point: smoothed.point, confidence: est.confidence, method: est.method },
    anchored.map((o) => {
      const sensor = sensors.find((s) => s.id === o.sensorId);
      return { sensorId: o.sensorId, rssi: o.rssi, sensor };
    }),
    est.method,
    { type: 'kalman', innovationM: smoothed.innovationM },
    geo,
  );
  pushLocation(d, smoothed.point, est.confidence, est.method, evidence, geo);

  // Observation history for the calibration wizard.
  if (!d._obsHistory) d._obsHistory = [];
  const topRssi = Math.max(...anchored.map((o) => o.rssi));
  d._obsHistory.push({ confidence: est.confidence, topRssi, clusterSpread: est.clusterSpread || 0 });
  if (d._obsHistory.length > 200) d._obsHistory = d._obsHistory.slice(-200);
}

bus.on('signal', (sig) => {
  const d = getDevice(sig.device);
  d.signals.push(sig);

  if (sig.sensorId) {
    handleSensorObservation(d, sig);
  } else if (Number.isFinite(sig.lat) && Number.isFinite(sig.lon)) {
    if (engineAvailable() || filterAvailable()) {
      handleGpsFix(d, sig);
    } else {
      // Legacy centroid path: needs >=3 signals per device.
      const loc = triangulate(d.signals);
      if (loc) {
        d.locations.push(loc);
        d.path.push(loc);
      }
    }
  }

  if (typeof updateMap === 'function') updateMap();
  if (typeof drawRF === 'function') drawRF(sig);
});

const WorldmapTriangulation = {
  triangulate,
  engineAvailable,
};

if (typeof window !== 'undefined') window.WorldmapTriangulation = WorldmapTriangulation;
