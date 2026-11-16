/**
 * ARC v10 — Offline Worldmap plugin: evidence packs.
 *
 * Step 10 of the plan: every location carries its inputs — the
 * observations, the calibration, the confidence and the error
 * that produced it — saved with the track, exportable as JSON.
 * A location claim you cannot check is a claim, not a measurement.
 *
 * Attach as window.WorldmapEvidence. No dependencies.
 */

/**
 * Build one evidence pack for a fix.
 * fix: {point:{lat,lon}, confidence, method?}
 * observations: [{sensorId, rssi, distanceM?, reliability?}]
 * calibration: profile object or key ({noise, attenuation, ...}).
 * method: estimator method name ('weighted' | 'multilateration' | 'gps').
 * filterState: {type:'kalman'|'particle'|..., innovationM?}
 * zone: continuum zone for the fix ('Center-Core' | 'North Zone' | ...),
 *   or null when the fix is outside every structure.
 * geofenceHits: continuum geofence hits [{geofence_id, name, severity,
 *   geofence_type}] — [] when none.
 */
function buildEvidencePack(input) {
  const opts = input || {};
  const fix = opts.fix || {};
  const point = fix.point || { lat: fix.lat, lon: fix.lon };
  const confidence = typeof fix.confidence === 'number' ? fix.confidence : 0;
  const calibration = opts.calibration || {};
  const filterState = opts.filterState || null;
  const innovationM = filterState && typeof filterState.innovationM === 'number' ? filterState.innovationM : 0;
  return {
    time: new Date().toISOString(),
    point: { lat: point.lat, lon: point.lon },
    confidence,
    method: opts.method || fix.method || 'unknown',
    zone: typeof opts.zone === 'string' ? opts.zone : null,
    geofenceHits: Array.isArray(opts.geofenceHits)
      ? opts.geofenceHits.map((h) => ({
          geofence_id: h.geofence_id || null,
          name: h.name || null,
          severity: typeof h.severity === 'number' ? h.severity : null,
          geofence_type: h.geofence_type || null,
        }))
      : [],
    errorEstimateM: Number(((1 - confidence) * 20 + 1 + innovationM).toFixed(2)),
    calibration: {
      noise: typeof calibration.noise === 'number' ? calibration.noise : null,
      attenuation: typeof calibration.attenuation === 'number' ? calibration.attenuation : null,
      name: calibration.name || (typeof opts.calibrationKey === 'string' ? opts.calibrationKey : null),
    },
    observations: (opts.observations || []).map((o) => ({
      sensorId: o.sensorId || (o.sensor && o.sensor.id) || null,
      rssi: typeof o.rssi === 'number' ? Number(o.rssi.toFixed(2)) : null,
      distanceM: typeof o.distanceM === 'number' ? Number(o.distanceM.toFixed(2)) : null,
      reliability: typeof o.reliability === 'number' ? Number(o.reliability.toFixed(3)) : null,
    })),
    filter: filterState
      ? { type: filterState.type || null, innovationM: Number(innovationM.toFixed(2)) }
      : null,
  };
}

/** Serialise one pack or an array of packs as JSON. */
function exportEvidenceJSON(packs) {
  return JSON.stringify(packs, null, 2);
}

const WorldmapEvidence = {
  buildEvidencePack,
  exportEvidenceJSON,
};

if (typeof window !== 'undefined') window.WorldmapEvidence = WorldmapEvidence;
