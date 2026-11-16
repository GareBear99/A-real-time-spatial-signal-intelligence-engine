/**
 * ARC v10 — Offline Worldmap plugin: offline tiles.
 *
 * Two real-map modes, both with zero network at runtime:
 *
 *   'local'   — a tile directory laid out as {z}/{x}/{y}.png
 *               (the pure template builder lives here so it is
 *               unit-testable; arc/map.js has the same rule).
 *   'mbtiles' — a single-file MBTiles pack (SQLite), opened
 *               with the vendored sql.js and served by the
 *               vendored Leaflet.TileLayer.MBTiles layer.
 *
 * Flow (Gary's rule — pick a file or a folder once, the plugin
 * remembers it): the user picks an .mbtiles file (or a tile
 * folder for 'local'); openMbtilesFile opens it, and
 * createMbtilesLayer serves it. Nothing here fetches anything.
 *
 * Pure helpers (localTileTemplate / getTileBlob) are attached
 * to window.WorldmapTiles so they are unit-testable.
 */

let worldmapSqlLib = null;
let worldmapCurrentDb = null;
let worldmapCurrentMetadata = {};

/** Build a Leaflet tile template from a user-supplied tile
 *  path. Same rule as arc/map.js buildTileLayer: a path that
 *  already contains {z} is used as-is, otherwise
 *  /{z}/{x}/{y}.png is appended. */
function localTileTemplate(tilePath) {
  const raw = (tilePath || '').trim();
  if (!raw) return '';
  if (raw.indexOf('{z}') !== -1) return raw;
  return raw.replace(/\/+$/, '') + '/{z}/{x}/{y}.png';
}

/** A Leaflet TileLayer for a local tile directory, or null
 *  when Leaflet is not loaded / no path was given. */
function createLocalTileLayer(tilePath) {
  const template = localTileTemplate(tilePath);
  if (!template || typeof L === 'undefined') return null;
  return L.tileLayer(template, { maxZoom: 19 });
}

/** Load sql.js (vendored). `opts` may carry `wasmBinary`
 *  (tests / non-page use) or a `locateFile` override;
 *  otherwise the wasm is loaded from ./vendor/sql-wasm.wasm
 *  relative to the plugin page. */
async function loadSqlJs(opts) {
  if (worldmapSqlLib) return worldmapSqlLib;
  if (typeof initSqlJs === 'undefined') {
    throw new Error('sql.js is not loaded (vendor/sql-wasm.js).');
  }
  const initOpts = {};
  if (opts && opts.wasmBinary) initOpts.wasmBinary = opts.wasmBinary;
  if (opts && opts.locateFile) {
    initOpts.locateFile = opts.locateFile;
  } else {
    initOpts.locateFile = function (file) {
      return './vendor/' + file;
    };
  }
  worldmapSqlLib = await initSqlJs(initOpts);
  return worldmapSqlLib;
}

/** Read the metadata table into a plain object. Never throws. */
function readMetadata(db) {
  const out = {};
  if (!db) return out;
  try {
    const res = db.exec('SELECT name, value FROM metadata');
    if (res && res.length && res[0].values) {
      res[0].values.forEach((row) => {
        out[String(row[0])] = row[1] === null || row[1] === undefined ? '' : String(row[1]);
      });
    }
  } catch (e) {
    // No metadata table — a bare tiles table still works.
  }
  return out;
}

/** Open an MBTiles pack from raw bytes. Returns
 *  Promise<{db, metadata}>. The db is kept as the current
 *  one (for createMbtilesLayer() with no argument). */
async function openMbtilesBuffer(arrayBuffer, opts) {
  const SQL = await loadSqlJs(opts);
  const db = new SQL.Database(new Uint8Array(arrayBuffer));
  worldmapCurrentDb = db;
  worldmapCurrentMetadata = readMetadata(db);
  return { db: db, metadata: worldmapCurrentMetadata };
}

/** Open a user-picked .mbtiles File. Returns
 *  Promise<{db, metadata}>. */
async function openMbtilesFile(file, opts) {
  if (!file) throw new Error('No file given.');
  let buf = null;
  if (typeof file.arrayBuffer === 'function') {
    buf = await file.arrayBuffer();
  } else {
    buf = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read the MBTiles file.'));
      reader.readAsArrayBuffer(file);
    });
  }
  return openMbtilesBuffer(buf, opts);
}

/** One tile's raw bytes from an open MBTiles db, or null.
 *  MBTiles tile_row is TMS (origin bottom-left); Leaflet's y
 *  is XYZ (origin top-left), so the row is flipped. */
function queryTileBytes(db, z, x, y) {
  if (!db) return null;
  try {
    const stmt = db.prepare(
      'SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?',
    );
    stmt.bind([z, x, (Math.pow(2, z) - 1) - y]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject();
    stmt.free();
    const data = row && row.tile_data;
    if (!data) return null;
    return data instanceof Uint8Array ? data : new Uint8Array(data);
  } catch (e) {
    return null;
  }
}

/** One tile as a Blob (image/png, or image/jpeg when the
 *  bytes are JPEG), or null when the tile is not in the pack. */
function getTileBlob(db, z, x, y) {
  const bytes = queryTileBytes(db, z, x, y);
  if (!bytes) return null;
  let type = 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) type = 'image/jpeg';
  return new Blob([bytes], { type: type });
}

/** A Leaflet layer serving tiles from an open MBTiles db
 *  (defaults to the most recently opened one). Uses the
 *  vendored L.TileLayer.MBTiles — one path, no URL fetching. */
function createMbtilesLayer(db) {
  const useDb = db || worldmapCurrentDb;
  if (!useDb) throw new Error('No MBTiles database is open.');
  if (typeof L === 'undefined' || !L.TileLayer || !L.TileLayer.MBTiles) {
    throw new Error('Leaflet.TileLayer.MBTiles is not loaded (vendor/Leaflet.TileLayer.MBTiles.js).');
  }
  return new L.TileLayer.MBTiles(useDb, {});
}

/** Close the current db, if any. Safe to call twice. */
function closeMbtiles() {
  if (worldmapCurrentDb) {
    try {
      worldmapCurrentDb.close();
    } catch (e) {
      // Already closed — ignore.
    }
  }
  worldmapCurrentDb = null;
  worldmapCurrentMetadata = {};
  return true;
}

const WorldmapTiles = {
  localTileTemplate,
  createLocalTileLayer,
  loadSqlJs,
  openMbtilesBuffer,
  openMbtilesFile,
  queryTileBytes,
  getTileBlob,
  createMbtilesLayer,
  closeMbtiles,
  readMetadata,
  get currentDb() {
    return worldmapCurrentDb;
  },
  get currentMetadata() {
    return worldmapCurrentMetadata;
  },
};

if (typeof window !== 'undefined') window.WorldmapTiles = WorldmapTiles;
