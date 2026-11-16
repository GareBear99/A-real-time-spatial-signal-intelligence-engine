/**
 * Leaflet.TileLayer.MBTiles — minimal offline MBTiles layer.
 *
 * Written for the Offline Worldmap plugin (2026-11-15) because
 * the upstream this was modelled on,
 * timwis/Leaflet.TileLayer.MBTiles, is no longer fetchable
 * (raw.githubusercontent.com and the GitHub API both return
 * 404 for that repo as of 2026-11-15), so there was nothing
 * to vendor. This file is the minimal equivalent: an
 * L.GridLayer subclass that serves tiles from an already-open
 * sql.js database (opened by arc/tiles.js from a user-picked
 * .mbtiles file) — no network, no URL fetching.
 *
 * Unlike the upstream, this layer takes an OPEN database,
 * not a URL: the plugin's flow is file-pick, so the file is
 * opened once by arc/tiles.js and the db is handed here.
 *
 *   const layer = L.tileLayer.mbTiles(db);   // db: sql.js Database
 *   layer.addTo(map);
 *
 * MBTiles tile_row is TMS (origin bottom-left), Leaflet's y
 * is XYZ (origin top-left), so the row is flipped:
 * tile_row = (2^z - 1) - y.
 *
 * No dependency beyond Leaflet (global L) and the db object.
 * License: MIT (same as the plugin's vendored Leaflet).
 */

(function () {
  if (typeof L === 'undefined') return;

  /** PNG/JPEG sniff for the Blob MIME type. Defaults to PNG. */
  function sniffMime(bytes) {
    if (bytes && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    return 'image/png';
  }

  /** Query one tile's bytes from an open MBTiles db, or null. */
  function queryTileData(db, z, x, y) {
    if (!db) return null;
    try {
      var stmt = db.prepare(
        'SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?',
      );
      stmt.bind([z, x, (Math.pow(2, z) - 1) - y]);
      if (!stmt.step()) {
        stmt.free();
        return null;
      }
      var row = stmt.getAsObject();
      stmt.free();
      var data = row && row.tile_data;
      if (!data) return null;
      return data instanceof Uint8Array ? data : new Uint8Array(data);
    } catch (e) {
      return null;
    }
  }

  /** Bytes -> a URL an <img> can load. Prefers a Blob URL;
   *  falls back to a base64 data URL where Blob URLs are
   *  unavailable (e.g. jsdom). */
  function bytesToUrl(bytes) {
    var mime = sniffMime(bytes);
    try {
      if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
        return URL.createObjectURL(new Blob([bytes], { type: mime }));
      }
    } catch (e) {
      // Fall through to the data-URL path.
    }
    var bin = '';
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    var b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
    return 'data:' + mime + ';base64,' + b64;
  }

  var BLANK =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  L.TileLayer.MBTiles = L.GridLayer.extend({
    options: { tileSize: 256 },

    initialize: function (db, options) {
      L.GridLayer.prototype.initialize.call(this, options);
      this._db = db || null;
    },

    createTile: function (coords, done) {
      var tile = document.createElement('img');
      tile.alt = '';
      tile.setAttribute('role', 'presentation');
      var data = queryTileData(this._db, coords.z, coords.x, coords.y);
      var url = data ? bytesToUrl(data) : BLANK;
      var finished = false;
      var finish = function () {
        if (finished) return;
        finished = true;
        if (url.indexOf('blob:') === 0) {
          try {
            URL.revokeObjectURL(url);
          } catch (e) {
            // Best effort.
          }
        }
        if (done) done(null, tile);
      };
      tile.onload = finish;
      tile.onerror = finish;
      tile.src = url;
      // If the image is already complete (cached / data URL
      // in some engines), onload may never fire again.
      if (tile.complete) setTimeout(finish, 0);
      return tile;
    },
  });

  L.tileLayer.mbTiles = function (db, options) {
    return new L.TileLayer.MBTiles(db, options);
  };

  // Exposed for arc/tiles.js and tests: the raw query.
  L.TileLayer.MBTiles.queryTileData = queryTileData;
  L.TileLayer.MBTiles.bytesToUrl = bytesToUrl;
})();
