
/**
 * ARC v10 — Offline Worldmap plugin: real GPS input.
 *
 * The original engine only had the simulator (random fixes
 * around Williams Lake). Real GPS projects need real fixes:
 *
 *   - Geolocation API (navigator.geolocation.watchPosition):
 *     works offline on device GPS — the fix comes from the
 *     device, not the network. In Lucid's Electron shell
 *     there is no location provider, so watchPosition errors
 *     and the plugin says so instead of pretending.
 *   - GPX file import: <trkpt>/<wpt> points from a .gpx file
 *     the user picks. Fully offline, file-based.
 *   - NMEA file import: $GPGGA / $GPRMC sentences from a
 *     .nmea/.txt file the user picks. Fully offline.
 *
 * Every fix is fed through the same bus ('signal') the
 * simulator uses, so triangulation, path history, heat and
 * markers all work unchanged for real fixes.
 *
 * Pure parsers (parseGPX / parseNMEA) are attached to
 * window.WorldmapGPS so they are unit-testable.
 */

function parseNmeaLat(raw, hemi) {
  if (!raw || !hemi) return null;
  const degrees = parseInt(raw.slice(0, 2), 10);
  const minutes = parseFloat(raw.slice(2));
  if (!Number.isFinite(degrees) || !Number.isFinite(minutes)) return null;
  let value = degrees + minutes / 60;
  if (hemi === 'S' || hemi === 'W') value = -value;
  return value;
}

function parseNmeaLon(raw, hemi) {
  if (!raw || !hemi) return null;
  const degrees = parseInt(raw.slice(0, 3), 10);
  const minutes = parseFloat(raw.slice(3));
  if (!Number.isFinite(degrees) || !Number.isFinite(minutes)) return null;
  let value = degrees + minutes / 60;
  if (hemi === 'S' || hemi === 'W') value = -value;
  return value;
}

/** Parse NMEA text ($GPGGA with a valid fix, $GPRMC with
 *  status A). Returns [{lat, lon, time}] in file order. */
function parseNMEA(text) {
  const fixes = [];
  if (typeof text !== 'string') return fixes;
  text.split(/\r?\n/).forEach((line) => {
    const fields = line.trim().split(',');
    if (fields.length < 2) return;
    const type = fields[0].slice(3); // $GPGGA -> GGA
    if (type === 'GGA') {
      // $GPGGA,time,lat,N/S,lon,E/W,fixQuality,...
      if (fields[6] === '0' || fields[6] === '') return; // no fix
      const lat = parseNmeaLat(fields[2], fields[3]);
      const lon = parseNmeaLon(fields[4], fields[5]);
      if (lat === null || lon === null) return;
      fixes.push({ lat, lon, time: fields[1] || null });
    } else if (type === 'RMC') {
      // $GPRMC,time,A,lat,N/S,lon,E/W,...
      if (fields[2] !== 'A') return; // void
      const lat = parseNmeaLat(fields[3], fields[4]);
      const lon = parseNmeaLon(fields[5], fields[6]);
      if (lat === null || lon === null) return;
      fixes.push({ lat, lon, time: fields[1] || null });
    }
  });
  return fixes;
}

/** Parse GPX text (<trkpt> and <wpt>). Returns
 *  [{lat, lon, time, ele}] in file order. */
function parseGPX(text) {
  const fixes = [];
  if (typeof text !== 'string' || typeof DOMParser === 'undefined') return fixes;
  let doc = null;
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml');
  } catch (e) {
    return fixes;
  }
  if (!doc || doc.getElementsByTagName('parsererror').length) return fixes;
  const points = doc.querySelectorAll('trkpt, wpt');
  points.forEach((pt) => {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const timeEl = pt.querySelector('time');
    const eleEl = pt.querySelector('ele');
    fixes.push({
      lat,
      lon,
      time: timeEl ? timeEl.textContent : null,
      ele: eleEl ? parseFloat(eleEl.textContent) : null,
    });
  });
  return fixes;
}

let geolocationWatchId = null;

const WorldmapGPS = {
  parseGPX,
  parseNMEA,

  /** Feed fixes into the engine as signals for one device,
   *  through the same bus the simulator uses. */
  feedFixes(deviceId, fixes) {
    if (!Array.isArray(fixes)) return 0;
    let fed = 0;
    fixes.forEach((fix) => {
      if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return;
      bus.emit('signal', {
        device: deviceId,
        rssi: -50,
        lat: fix.lat,
        lon: fix.lon,
        time: fix.time || null,
      });
      fed += 1;
    });
    return fed;
  },

  /** Device GPS. Calls onFix({lat, lon}) per position and
   *  onError(message) when the device cannot provide one
   *  (e.g. no location provider in Electron). */
  startGeolocation(onFix, onError) {
    if (!navigator.geolocation) {
      if (onError) onError('Geolocation is not available in this shell.');
      return false;
    }
    try {
      geolocationWatchId = navigator.geolocation.watchPosition(
        (pos) => {
          if (onFix) onFix({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        },
        (err) => {
          if (onError) onError(err && err.message ? err.message : 'Geolocation failed.');
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
      );
      return true;
    } catch (e) {
      if (onError) onError(e && e.message ? e.message : 'Geolocation failed.');
      return false;
    }
  },

  stopGeolocation() {
    if (geolocationWatchId !== null && navigator.geolocation) {
      try {
        navigator.geolocation.clearWatch(geolocationWatchId);
      } catch (e) {
        // Best effort.
      }
    }
    geolocationWatchId = null;
  },

  /** Read a user-picked .gpx file and feed it as one device.
   *  Returns a Promise<number> — fixes fed. */
  loadGPXFile(file, deviceId) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const fixes = parseGPX(String(reader.result || ''));
          resolve(WorldmapGPS.feedFixes(deviceId || 'gpx-track', fixes));
        } catch (e) {
          reject(e);
        }
      };
      reader.onerror = () => reject(new Error('Could not read the GPX file.'));
      reader.readAsText(file);
    });
  },

  /** Read a user-picked .nmea/.txt file and feed it as one device. */
  loadNMEAFile(file, deviceId) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const fixes = parseNMEA(String(reader.result || ''));
          resolve(WorldmapGPS.feedFixes(deviceId || 'nmea-track', fixes));
        } catch (e) {
          reject(e);
        }
      };
      reader.onerror = () => reject(new Error('Could not read the NMEA file.'));
      reader.readAsText(file);
    });
  },
};

window.WorldmapGPS = WorldmapGPS;
