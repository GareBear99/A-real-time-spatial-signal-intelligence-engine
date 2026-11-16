/**
 * ARC v10 — Offline Worldmap plugin: real RF input.
 *
 * The plugin has no live RF capture (no WiFi/BLE scan in
 * Lucid's Electron shell), so real RF comes in the same way
 * real GPS does: a file the user picks. One row per
 * observation — {sensorId, rssi, time} — fed through the
 * same bus ('signal') the simulator uses, so imported scans
 * triangulate, plot, and filter exactly like live ones.
 *
 * Formats:
 *   CSV     — header `sensor,rssi,time` (time optional);
 *             one observation per line.
 *   JSON    — an array, or {observations:[...]}, of
 *             {sensor|sensorId|id, rssi, time}.
 *   airport — macOS `airport -s` output saved to a file:
 *             columns SSID BSSID RSSI CHANNEL HT CC SECURITY.
 *             The BSSID is the sensor id and RSSI is the
 *             column after it. SSIDs may contain spaces, so
 *             the BSSID is found by its MAC shape, not by
 *             column position.
 *
 * Parsers never throw on bad input: bad rows are skipped.
 * Scans may reference sensor ids the sensor store does not
 * know yet — they are still emitted (the estimator can use
 * them once the sensor is placed; step 2 gives sensors ids
 * and positions). Pure parsers are attached to
 * window.WorldmapRFImport so they are unit-testable.
 */

function isValidScan(scan) {
  return (
    scan &&
    typeof scan.sensorId === 'string' &&
    scan.sensorId.trim() !== '' &&
    Number.isFinite(scan.rssi)
  );
}

/** Split CSV text into rows of fields. No quoted-field
 *  support — scan exports are plain comma values. */
function splitCsvLine(line) {
  return line.split(',').map((f) => f.trim());
}

/** Parse CSV scan text. Header `sensor,rssi,time` is
 *  recognised (case-insensitive) and skipped; a file with
 *  no header is read as data. Returns [{sensorId, rssi,
 *  time}] in file order. Never throws. */
function parseScanCSV(text) {
  const scans = [];
  if (typeof text !== 'string') return scans;
  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const fields = splitCsvLine(line);
    if (index === 0 && fields.length >= 2) {
      const head = fields[0].toLowerCase();
      const second = fields[1].toLowerCase();
      if ((head === 'sensor' || head === 'sensorid' || head === 'sensor_id' || head === 'id') && second === 'rssi') {
        return; // header row
      }
    }
    if (fields.length < 2) return;
    const rssi = parseFloat(fields[1]);
    const scan = {
      sensorId: fields[0],
      rssi: rssi,
      time: fields.length > 2 && fields[2] !== '' ? fields[2] : null,
    };
    if (isValidScan(scan)) scans.push(scan);
  });
  return scans;
}

/** Parse one JSON observation object into the scan shape,
 *  or null when it is not a valid observation. */
function scanFromJsonObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const sensorId = obj.sensorId !== undefined ? obj.sensorId : obj.sensor !== undefined ? obj.sensor : obj.id;
  const rssi = typeof obj.rssi === 'string' ? parseFloat(obj.rssi) : obj.rssi;
  const scan = {
    sensorId: typeof sensorId === 'string' ? sensorId : sensorId === null || sensorId === undefined ? '' : String(sensorId),
    rssi: rssi,
    time: obj.time !== undefined && obj.time !== null ? String(obj.time) : null,
  };
  return isValidScan(scan) ? scan : null;
}

/** Parse JSON scan text — an array, or
 *  {observations:[...]}. Returns [{sensorId, rssi, time}].
 *  Never throws. */
function parseScanJSON(text) {
  const scans = [];
  if (typeof text !== 'string') return scans;
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return scans;
  }
  const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.observations) ? parsed.observations : null;
  if (!list) return scans;
  list.forEach((obj) => {
    const scan = scanFromJsonObject(obj);
    if (scan) scans.push(scan);
  });
  return scans;
}

const MAC_RE = /([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}/;

/** Parse macOS `airport -s` output. Each scan line has an
 *  SSID (which may contain spaces), then BSSID, RSSI,
 *  CHANNEL, HT, CC, SECURITY. The BSSID (MAC) is the sensor
 *  id; the token right after it is the RSSI. The header line
 *  (starts with SSID, no MAC) is skipped. Returns
 *  [{sensorId, rssi, time}] (time is always null — airport
 *  prints no timestamp). Never throws. */
function parseAirportScan(text) {
  const scans = [];
  if (typeof text !== 'string') return scans;
  text.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    const mac = line.match(MAC_RE);
    if (!mac) return; // header line or junk
    const after = line.slice(mac.index + mac[0].length).trim().split(/\s+/);
    if (!after.length) return;
    const rssi = parseInt(after[0], 10);
    const scan = { sensorId: mac[0].toLowerCase(), rssi: rssi, time: null };
    if (isValidScan(scan)) scans.push(scan);
  });
  return scans;
}

/** Guess the format of scan-file text: 'json' when it starts
 *  with [ or {, 'airport' when the first non-empty line
 *  starts with SSID, otherwise 'csv'. */
function detectScanFormat(text) {
  if (typeof text !== 'string') return 'csv';
  const trimmed = text.trim();
  if (trimmed.charAt(0) === '[' || trimmed.charAt(0) === '{') return 'json';
  const first = trimmed.split(/\r?\n/).find((l) => l.trim() !== '');
  if (first && first.trim().toUpperCase().indexOf('SSID') === 0) return 'airport';
  return 'csv';
}

/** Parse scan text in any supported format. Never throws. */
function parseScanFile(text) {
  const format = detectScanFormat(text);
  if (format === 'json') return parseScanJSON(text);
  if (format === 'airport') return parseAirportScan(text);
  return parseScanCSV(text);
}

/** Feed scans into the engine as signals for one device,
 *  through the same bus the simulator and GPS use. Returns
 *  the number of signals emitted. Unknown sensor ids are
 *  still emitted — the estimator can use them once the
 *  sensor is placed. */
function feedScans(deviceId, scans) {
  if (!Array.isArray(scans)) return 0;
  let fed = 0;
  scans.forEach((scan) => {
    if (!isValidScan(scan)) return;
    if (typeof bus !== 'undefined' && bus && typeof bus.emit === 'function') {
      bus.emit('signal', {
        device: deviceId,
        sensorId: scan.sensorId,
        rssi: scan.rssi,
        time: scan.time || null,
      });
      fed += 1;
    }
  });
  return fed;
}

/** Read a user-picked scan file (CSV, JSON, or airport -s
 *  output — detected by content) and feed it as one device.
 *  Returns a Promise<number> — scans fed. */
function loadScanFile(file, deviceId) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('No file given.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const scans = parseScanFile(String(reader.result || ''));
        resolve(feedScans(deviceId || 'scan-import', scans));
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = () => reject(new Error('Could not read the scan file.'));
    reader.readAsText(file);
  });
}

const WorldmapRFImport = {
  parseScanCSV,
  parseScanJSON,
  parseAirportScan,
  parseScanFile,
  detectScanFormat,
  feedScans,
  loadScanFile,
};

if (typeof window !== 'undefined') window.WorldmapRFImport = WorldmapRFImport;
