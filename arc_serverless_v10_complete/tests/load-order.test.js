'use strict';
/**
 * Load-order + settings smoke tests (node:test, no dependencies).
 *
 * Loads every engine file in the exact order index.html loads
 * them, with stubbed browser globals, and checks that all
 * namespaces attach, the new continuum settings round-trip
 * through sanitize, and the default centre is untouched.
 *
 * Run: npm test   (node --test arc_serverless_v10_complete/tests/)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FILES = [
  'bus.js', 'entities.js', 'geo.js', 'pathloss.js', 'estimator.js',
  'continuum.js', 'filter.js', 'lab.js', 'evidence.js', 'simulator.js',
  'triangulation.js', 'map.js', 'sensors.js', 'rf_canvas.js',
  'room_inference.js', 'fingerprint.js', 'tiles.js', 'rfimport.js',
  'gps.js', 'settings.js',
];

function loadAll() {
  const dir = path.join(__dirname, '..', 'arc');
  const store = {};
  const sandbox = {
    console,
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } },
    document: { getElementById: () => null, createElement: () => ({ style: {}, appendChild() {} }) },
    navigator: {},
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    bus: { on() {} },
    L: { map: () => ({}), polygon: () => ({}), GridLayer: { extend: () => function () {} } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.parent = sandbox;
  vm.createContext(sandbox);
  for (const f of FILES) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox;
}

test('all engine files load in page order and attach their namespaces', () => {
  const ctx = loadAll();
  for (const n of [
    'WorldmapGeo', 'WorldmapPathloss', 'WorldmapEstimator', 'WorldmapContinuum',
    'WorldmapFilter', 'WorldmapLab', 'WorldmapEvidence', 'WorldmapTriangulation',
    'WorldmapSensors', 'WorldmapGPS', 'WorldmapSettings',
  ]) {
    assert.notEqual(vm.runInContext('typeof ' + n, ctx), 'undefined', n + ' missing');
  }
  // The continuum module is on the debug hook's namespace list.
  assert.equal(typeof ctx.WorldmapContinuum.CONTINUUM_STRUCTURES, 'object');
});

test('continuum settings round-trip; bogus values fall back to defaults', () => {
  const ctx = loadAll();
  const result = vm.runInContext(`(() => {
    const s = WorldmapSettings.set({ estimatorMethod: 'weighted-rssi-centroid', calibrationProfile: 'arc-default', showContinuum: false, showContinuumHeat: true });
    const ok1 = s.estimatorMethod === 'weighted-rssi-centroid' && s.calibrationProfile === 'arc-default' && s.showContinuum === false && s.showContinuumHeat === true;
    const back = WorldmapSettings.set({ estimatorMethod: 'bogus', calibrationProfile: 'bogus' });
    const ok2 = back.estimatorMethod === 'multilateration' && back.calibrationProfile === 'balanced';
    const d = WorldmapSettings.load();
    const ok3 = d.centerLat === 52.131 && d.centerLon === -122.141;
    return JSON.stringify({ ok1, ok2, ok3 });
  })()`, ctx);
  assert.deepEqual(JSON.parse(result), { ok1: true, ok2: true, ok3: true });
});

test('index.html keeps the offline install shape', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(!/unpkg|openstreetmap/i.test(html), 'no CDN / OSM strings in index.html');
  assert.ok(html.includes('src="arc/continuum.js"'), 'continuum.js is loaded by the page');
  for (const f of ['arc/bus.js', 'arc/geo.js', 'arc/estimator.js', 'arc/map.js', 'arc/settings.js']) {
    assert.ok(html.includes('src="' + f + '"'), f + ' still loaded');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.ok(manifest.files.includes('arc/continuum.js'), 'manifest lists continuum.js');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'vendor', 'leaflet.js')), 'vendored leaflet present');
});
