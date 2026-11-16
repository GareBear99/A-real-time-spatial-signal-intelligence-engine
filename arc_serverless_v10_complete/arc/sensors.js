/**
 * ARC v10 — Offline Worldmap plugin: sensors.
 *
 * Real sensors: placed, not random (plan step 2). A sensor has a
 * known position — dropped on the map by click, imported from a
 * file (JSON/CSV, same file-import pattern as GPX), or seeded
 * inside a structure polygon by autoPlace (deterministic, the
 * v8 buildSensorsForStructure port — never Math.random()).
 * Positions persist in localStorage under 'arc-worldmap-sensors'.
 *
 * Sensors render as Leaflet circles via renderSensors(map), which
 * the page calls; toggleSensors() is the old show/hide button
 * name, kept as an alias — it never generates random sensors.
 *
 * Load after geo.js / pathloss.js / lab.js when available; the
 * store still works without them (small local fallbacks).
 */

const SENSOR_STORAGE_KEY = 'arc-worldmap-sensors';

/** Default structure when none is given: v8's Pine House. */
const DEFAULT_SENSOR_POLYGON = [
  [52.13188, -122.14235],
  [52.13188, -122.14203],
  [52.13168, -122.14203],
  [52.13168, -122.14235],
];

/* Leaflet layers for the stored sensors (the old `sensors`
 * global held these layers; the data lives in SensorStore). */
let sensors = [];
let visible = false;
let sensorIdCounter = 0;

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (e) {
    return null;
  }
}

function geo() {
  return typeof WorldmapGeo !== 'undefined' ? WorldmapGeo : null;
}

function pathloss() {
  return typeof WorldmapPathloss !== 'undefined' ? WorldmapPathloss : null;
}

/** Deterministic fallback point-in-polygon when geo.js is absent. */
function fallbackPointInPolygon(point, polygon) {
  const g = geo();
  if (g) return g.pointInPolygon(point, polygon);
  const x = point.lon;
  const y = point.lat;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][1];
    const yi = polygon[i][0];
    const xj = polygon[j][1];
    const yj = polygon[j][0];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

/** Seeded point inside a polygon; falls back to bounds sampling. */
function seededPoint(polygon, seed) {
  const g = geo();
  if (g) return g.seededPointInPolygon(polygon, seed);
  let t = (seed >>> 0) || 1;
  const rnd = () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const lats = polygon.map((p) => p[0]);
  const lons = polygon.map((p) => p[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  for (let i = 0; i < 800; i++) {
    const p = { lat: minLat + (maxLat - minLat) * rnd(), lon: minLon + (maxLon - minLon) * rnd() };
    if (fallbackPointInPolygon(p, polygon)) return p;
  }
  return { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
}

function polygonCentroid(polygon) {
  const g = geo();
  if (g) return g.centroid(polygon);
  const lat = polygon.reduce((a, p) => a + p[0], 0) / polygon.length;
  const lon = polygon.reduce((a, p) => a + p[1], 0) / polygon.length;
  return { lat, lon };
}

function cleanSensor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon !== undefined ? raw.lon : raw.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : null,
    lat,
    lon,
    floor: Number.isFinite(Number(raw.floor)) ? Math.max(1, Math.floor(Number(raw.floor))) : 1,
    reliability:
      typeof raw.reliability === 'number' && raw.reliability > 0 && raw.reliability <= 1
        ? raw.reliability
        : 0.86,
    history: Array.isArray(raw.history) ? raw.history.filter((h) => h && typeof h.error === 'number') : [],
  };
}

const SensorStore = {
  _list: [],

  list() {
    return this._list.map((s) => ({ ...s, history: [...(s.history || [])] }));
  },

  get(id) {
    return this._list.find((s) => s.id === id) || null;
  },

  add(lat, lon, floor) {
    sensorIdCounter += 1;
    const sensor = cleanSensor({
      id: 'sn-' + Date.now().toString(36) + '-' + sensorIdCounter,
      lat,
      lon,
      floor,
    });
    if (!sensor) return null;
    this._list.push(sensor);
    this.save();
    return { ...sensor };
  },

  /** Click-to-drop: place a sensor where the user clicked. */
  placeAt(lat, lon, floor) {
    const sensor = this.add(lat, lon, floor);
    if (sensor && visible) renderSensors();
    return sensor;
  },

  remove(id) {
    const before = this._list.length;
    this._list = this._list.filter((s) => s.id !== id);
    if (this._list.length !== before) {
      this.save();
      if (visible) renderSensors();
      return true;
    }
    return false;
  },

  clear() {
    this._list = [];
    this.save();
    if (visible) renderSensors();
  },

  /**
   * Import sensors from JSON: an array, or {sensors:[...]}, of
   * {id?, lat, lon, floor?} rows. Replaces a sensor with the
   * same id, appends the rest. Returns the number imported.
   */
  importJSON(text) {
    let parsed;
    try {
      parsed = JSON.parse(String(text || ''));
    } catch (e) {
      return 0;
    }
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.sensors) ? parsed.sensors : [];
    let count = 0;
    rows.forEach((row) => {
      const sensor = cleanSensor(row);
      if (!sensor) return;
      if (!sensor.id) {
        sensorIdCounter += 1;
        sensor.id = 'sn-' + Date.now().toString(36) + '-' + sensorIdCounter;
      }
      const existing = this._list.findIndex((s) => s.id === sensor.id);
      if (existing >= 0) this._list[existing] = sensor;
      else this._list.push(sensor);
      count += 1;
    });
    if (count) this.save();
    if (count && visible) renderSensors();
    return count;
  },

  /**
   * Import sensors from CSV: header row optional
   * (id,lat,lon,floor — any order, lat/lon required).
   * Returns the number imported.
   */
  importCSV(text) {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!lines.length) return 0;
    let start = 0;
    let cols = ['lat', 'lon', 'floor', 'id'];
    const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
    if (header.indexOf('lat') !== -1 && (header.indexOf('lon') !== -1 || header.indexOf('lng') !== -1)) {
      cols = header.map((h) => (h === 'lng' ? 'lon' : h));
      start = 1;
    }
    let count = 0;
    for (let i = start; i < lines.length; i++) {
      const parts = lines[i].split(',').map((p) => p.trim());
      const row = {};
      cols.forEach((col, idx) => {
        if (parts[idx] !== undefined && parts[idx] !== '') row[col] = parts[idx];
      });
      const sensor = cleanSensor(row);
      if (!sensor) continue;
      if (!sensor.id) {
        sensorIdCounter += 1;
        sensor.id = 'sn-' + Date.now().toString(36) + '-' + sensorIdCounter;
      }
      const existing = this._list.findIndex((s) => s.id === sensor.id);
      if (existing >= 0) this._list[existing] = sensor;
      else this._list.push(sensor);
      count += 1;
    }
    if (count) this.save();
    if (count && visible) renderSensors();
    return count;
  },

  /**
   * Seeded sensors inside a structure polygon + the centre
   * anchor (v8's buildSensorsForStructure). structure is a
   * polygon array or {id, polygon, levels}. Replaces the store.
   * Deterministic: same structure -> same sensors.
   */
  autoPlace(structure) {
    const polygon = Array.isArray(structure)
      ? structure
      : structure && Array.isArray(structure.polygon)
        ? structure.polygon
        : DEFAULT_SENSOR_POLYGON;
    const id = (structure && structure.id) || 's1';
    const levels = Math.max(1, Number((structure && structure.levels) || 1));
    const centre = polygonCentroid(polygon);
    const pts = [
      seededPoint(polygon, 11),
      seededPoint(polygon, 27),
      seededPoint(polygon, 53),
      seededPoint(polygon, 81),
      centre,
    ];
    this._list = pts.map((p, i) => ({
      id: `${id}-sn${i + 1}`,
      lat: p.lat,
      lon: p.lon,
      type: i === 4 ? 'center-anchor' : 'anchor',
      floor: 1 + (i % levels),
      reliability: 0.86 - i * 0.04,
      history: [],
    }));
    this.save();
    if (visible) renderSensors();
    return this.list();
  },

  /**
   * Record one error measurement for a sensor and recompute
   * its reliability (v8's sensorReliability history).
   */
  updateReliability(sensorId, errorM) {
    const sensor = this._list.find((s) => s.id === sensorId);
    if (!sensor || typeof errorM !== 'number' || !Number.isFinite(errorM)) return null;
    sensor.history = sensor.history || [];
    sensor.history.push({ error: errorM, time: Date.now() });
    if (sensor.history.length > 50) sensor.history = sensor.history.slice(-50);
    const pl = pathloss();
    if (pl) sensor.reliability = pl.sensorReliability(sensor);
    else {
      const avgAbs = sensor.history.reduce((a, b) => a + Math.abs(b.error || 0), 0) / sensor.history.length;
      sensor.reliability = Math.max(0.45, Math.min(0.99, 0.98 - avgAbs / 18));
    }
    this.save();
    return sensor.reliability;
  },

  save() {
    const store = storage();
    if (!store) return false;
    try {
      store.setItem(SENSOR_STORAGE_KEY, JSON.stringify(this._list));
      return true;
    } catch (e) {
      return false;
    }
  },

  load() {
    const store = storage();
    if (!store) return this.list();
    try {
      const raw = store.getItem(SENSOR_STORAGE_KEY);
      if (!raw) return this.list();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return this.list();
      this._list = parsed.map(cleanSensor).filter(Boolean);
    } catch (e) {
      // Bad JSON — keep whatever is in memory.
    }
    return this.list();
  },
};

/** Draw the stored sensors as Leaflet circles. No-op without L/map. */
function renderSensors(mapObj) {
  const target = mapObj || (typeof map !== 'undefined' ? map : null);
  sensors.forEach((layer) => {
    try {
      if (target && target.removeLayer) target.removeLayer(layer);
      else if (layer.remove) layer.remove();
    } catch (e) {
      // Best effort.
    }
  });
  sensors = [];
  if (!visible) return 0;
  if (typeof L === 'undefined' || !L.circle || !target) return 0;
  SensorStore.list().forEach((s) => {
    try {
      const layer = L.circle([s.lat, s.lon], { radius: 8, color: 'yellow' }).addTo(target);
      sensors.push(layer);
    } catch (e) {
      // A sensor that cannot draw is skipped, not fatal.
    }
  });
  return sensors.length;
}

/**
 * Show/hide the stored sensors (the old button name, kept).
 * Never generates random positions: if the store is empty the
 * first show seeds the default structure's sensors.
 */
function toggleSensors() {
  visible = !visible;
  if (visible) {
    if (!SensorStore.list().length) {
      try {
        SensorStore.load();
      } catch (e) {
        // Storage unavailable — fall through to autoPlace.
      }
      if (!SensorStore.list().length) SensorStore.autoPlace(DEFAULT_SENSOR_POLYGON);
    }
    renderSensors();
  } else {
    renderSensors();
  }
  return visible;
}

// Load persisted sensors at boot; storage may be unavailable.
try {
  SensorStore.load();
} catch (e) {
  // Standalone/sandboxed — start empty.
}

const WorldmapSensors = {
  SensorStore,
  SENSOR_STORAGE_KEY,
  DEFAULT_SENSOR_POLYGON,
  renderSensors,
  toggleSensors,
};

if (typeof window !== 'undefined') window.WorldmapSensors = WorldmapSensors;
