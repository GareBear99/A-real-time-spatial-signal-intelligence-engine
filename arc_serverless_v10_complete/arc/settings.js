
/**
 * ARC v10 — Offline Worldmap plugin: settings.
 *
 * The user-customizable surface. Defaults are the Williams Lake
 * centre the original shipped with (52.131, -122.141, zoom 15).
 * Nothing here is a network call: settings load from
 * localStorage when the page runs standalone, and from the
 * parent (Lucid) over postMessage when embedded — the parent
 * is the source of truth when embedded, localStorage is the
 * fallback for the standalone page.
 *
 * Tile modes:
 *   'grid'  — no tiles at all: a lat/lon graticule is drawn
 *             instead, so the map works with zero tile files.
 *   'local' — a tile directory the user points at (a file://
 *             path or a path relative to this page), laid out
 *             as {z}/{x}/{y}.png. A full {z}/{x}/{y} template
 *             is also accepted.
 *   'mbtiles' — a single .mbtiles file the user picks (offline
 *             tile pack, read with vendored sql.js). The file
 *             itself can't be persisted — the plugin remembers
 *             the name and asks to pick it again next session.
 *   'url'   — a tile URL template the user pastes in (online
 *             only, the user's own choice — never a default).
 *
 * Estimator: 'multilateration' (default — least-squares over
 * RSSI distances), 'weighted' (v8's RSSI-weighted average), or
 * 'weighted-rssi-centroid' (ARC-Core's estimator, exact port —
 * exponential-RSSI weights over all observations, ARC-Core
 * confidence formula). The track is smoothed by a Kalman filter
 * unless useFilter is false. fingerprintMode switches the
 * estimator to the surveyed radio map (kNN) when one is loaded.
 *
 * Continuum segment (arc/continuum.js — ARC-Core's geospatial
 * surface): showContinuum draws the seeded Williams Lake
 * structures + perimeter geofences on the map and classifies
 * every fix into a zone with geofence hits; showContinuumHeat
 * adds the per-structure track-density grid. Both default:
 * structures on, heat grid off.
 *
 * GPS sources:
 *   'none' | 'simulator' | 'geolocation' | 'gpx' | 'nmea'
 * The simulator is demo mode and defaults OFF in the plugin
 * (the original page only started it on a button press; the
 * plugin keeps that opt-in shape).
 */

const WORLDMAP_SETTINGS_KEY = 'arc-worldmap-settings';

const WORLDMAP_DEFAULT_SETTINGS = {
  centerLat: 52.131,
  centerLon: -122.141,
  zoom: 15,
  tileMode: 'grid',
  tilePath: '',
  tileUrlTemplate: '',
  mbtilesPath: '',
  gpsSource: 'none',
  simulatorDevices: ['phone1', 'phone2'],
  simulatorIntervalMs: 600,
  showPaths: true,
  estimatorMethod: 'multilateration',
  useFilter: true,
  fingerprintMode: false,
  calibrationProfile: 'balanced',
  showContinuum: true,
  showContinuumHeat: false,
};

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Keep only known keys, coerce to sane types, fall back to
 *  defaults for anything missing or out of range. Never throws. */
function sanitizeWorldmapSettings(raw) {
  const out = Object.assign({}, WORLDMAP_DEFAULT_SETTINGS);
  if (!raw || typeof raw !== 'object') return out;
  if (isFiniteNumber(raw.centerLat) && raw.centerLat >= -90 && raw.centerLat <= 90) out.centerLat = raw.centerLat;
  if (isFiniteNumber(raw.centerLon) && raw.centerLon >= -180 && raw.centerLon <= 180) out.centerLon = raw.centerLon;
  if (isFiniteNumber(raw.zoom) && raw.zoom >= 0 && raw.zoom <= 19) out.zoom = Math.floor(raw.zoom);
  if (raw.tileMode === 'grid' || raw.tileMode === 'local' || raw.tileMode === 'url' || raw.tileMode === 'mbtiles') out.tileMode = raw.tileMode;
  if (typeof raw.tilePath === 'string') out.tilePath = raw.tilePath.trim();
  if (typeof raw.tileUrlTemplate === 'string') out.tileUrlTemplate = raw.tileUrlTemplate.trim();
  if (typeof raw.mbtilesPath === 'string') out.mbtilesPath = raw.mbtilesPath.trim();
  if (['none', 'simulator', 'geolocation', 'gpx', 'nmea'].indexOf(raw.gpsSource) !== -1) out.gpsSource = raw.gpsSource;
  if (Array.isArray(raw.simulatorDevices)) {
    const names = raw.simulatorDevices.filter((d) => typeof d === 'string' && d.trim()).slice(0, 20);
    if (names.length) out.simulatorDevices = names;
  }
  if (isFiniteNumber(raw.simulatorIntervalMs) && raw.simulatorIntervalMs >= 100 && raw.simulatorIntervalMs <= 60000) {
    out.simulatorIntervalMs = Math.floor(raw.simulatorIntervalMs);
  }
  if (typeof raw.showPaths === 'boolean') out.showPaths = raw.showPaths;
  if (raw.estimatorMethod === 'weighted' || raw.estimatorMethod === 'multilateration' || raw.estimatorMethod === 'weighted-rssi-centroid') out.estimatorMethod = raw.estimatorMethod;
  if (typeof raw.useFilter === 'boolean') out.useFilter = raw.useFilter;
  if (typeof raw.fingerprintMode === 'boolean') out.fingerprintMode = raw.fingerprintMode;
  if (
    raw.calibrationProfile === 'balanced' ||
    raw.calibrationProfile === 'urban' ||
    raw.calibrationProfile === 'residential' ||
    raw.calibrationProfile === 'interference' ||
    raw.calibrationProfile === 'wizard' ||
    raw.calibrationProfile === 'arc-default'
  ) {
    out.calibrationProfile = raw.calibrationProfile;
  }
  if (typeof raw.showContinuum === 'boolean') out.showContinuum = raw.showContinuum;
  if (typeof raw.showContinuumHeat === 'boolean') out.showContinuumHeat = raw.showContinuumHeat;
  return out;
}

const WorldmapSettings = {
  current: Object.assign({}, WORLDMAP_DEFAULT_SETTINGS),

  get() {
    return Object.assign({}, this.current);
  },

  /** Merge a patch over the current settings, persist, apply,
   *  and tell the parent (when embedded) what changed. */
  set(patch) {
    this.current = sanitizeWorldmapSettings(Object.assign({}, this.current, patch));
    this.save();
    if (typeof applyWorldmapSettings === 'function') applyWorldmapSettings(this.current);
    this.postToParent({ type: 'worldmap:settings-changed', settings: this.get() });
    return this.get();
  },

  load() {
    try {
      const raw = window.localStorage.getItem(WORLDMAP_SETTINGS_KEY);
      if (raw) this.current = sanitizeWorldmapSettings(JSON.parse(raw));
    } catch (e) {
      // No storage (sandboxed iframe) or bad JSON — defaults stand.
    }
    return this.get();
  },

  save() {
    try {
      window.localStorage.setItem(WORLDMAP_SETTINGS_KEY, JSON.stringify(this.current));
    } catch (e) {
      // Sandboxed iframe: no storage. The parent holds the settings.
    }
  },

  postToParent(message) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(message, '*');
      }
    } catch (e) {
      // No parent — standalone page.
    }
  },
};

/** Parent (Lucid) pushes settings in: { type: 'worldmap:settings', settings }.
 *  The parent is the source of truth when embedded. */
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'worldmap:settings' && data.settings) {
    WorldmapSettings.current = sanitizeWorldmapSettings(data.settings);
    if (typeof applyWorldmapSettings === 'function') applyWorldmapSettings(WorldmapSettings.current);
    if (typeof syncWorldmapSettingsUI === 'function') syncWorldmapSettingsUI(WorldmapSettings.current);
  }
  if (data.type === 'worldmap:request-state') {
    WorldmapSettings.postToParent({ type: 'worldmap:state', settings: WorldmapSettings.get() });
  }
});
