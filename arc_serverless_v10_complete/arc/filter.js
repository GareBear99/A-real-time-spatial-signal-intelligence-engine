/**
 * ARC v10 — Offline Worldmap plugin: tracking filters.
 *
 * (5a) KalmanFilter2D — constant-velocity Kalman filter in local
 * metres. State [x, y, vx, vy]; the measurement is an estimator
 * fix, and the measurement noise R comes from the fix's
 * confidence (a confident fix counts for more).
 * (5b) ParticleFilter — a cloud of hypotheses in local metres.
 * Motion model with velocity + noise; weights from the distance
 * to the latest fix; systematic resampling; and the hard wall
 * constraint — particles that would cross a floor-plan polygon
 * boundary are killed (reverted), so the track can never
 * teleport through a wall.
 *
 * Both work in local metres; convert with WorldmapGeo
 * toLocalMeters / fromLocalMeters at the edges. Load after geo.js.
 */

function matMul(A, B) {
  const rows = A.length;
  const cols = B[0].length;
  const inner = B.length;
  const out = [];
  for (let i = 0; i < rows; i++) {
    out.push([]);
    for (let j = 0; j < cols; j++) {
      let s = 0;
      for (let k = 0; k < inner; k++) s += A[i][k] * B[k][j];
      out[i].push(s);
    }
  }
  return out;
}

function matVec(A, v) {
  return A.map((row) => row.reduce((s, a, i) => s + a * v[i], 0));
}

function matTranspose(A) {
  return A[0].map((_, j) => A.map((row) => row[j]));
}

function matAdd(A, B) {
  return A.map((row, i) => row.map((v, j) => v + B[i][j]));
}

function matSub(A, B) {
  return A.map((row, i) => row.map((v, j) => v - B[i][j]));
}

function matIdentity(n) {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

function invert2x2(m) {
  const det = m[0][0] * m[1][1] - m[0][1] * m[1][0] || 1e-12;
  return [
    [m[1][1] / det, -m[0][1] / det],
    [-m[1][0] / det, m[0][0] / det],
  ];
}

/** Measurement sigma (metres) implied by a fix confidence. */
function sigmaFromConfidence(confidence) {
  const c = typeof confidence === 'number' ? Math.min(0.99, Math.max(0, confidence)) : 0.5;
  return 1.5 + (1 - c) * 12;
}

class KalmanFilter2D {
  /**
   * options: {processNoise} — acceleration variance (m^2/s^4),
   * default 0.5. Start with reset(x, y) before first update.
   */
  constructor(options) {
    const opts = options || {};
    this.q = typeof opts.processNoise === 'number' ? opts.processNoise : 0.5;
    this.x = [0, 0, 0, 0];
    this.P = matIdentity(4).map((row) => row.map((v) => v * 100));
    this.innovationM = 0;
    this.initialized = false;
    this.lastTime = null;
  }

  reset(x, y) {
    this.x = [x, y, 0, 0];
    this.P = matIdentity(4).map((row) => row.map((v) => v * 100));
    this.innovationM = 0;
    this.initialized = true;
    this.lastTime = null;
  }

  predict(dt) {
    if (!this.initialized) return;
    const step = Math.min(5, Math.max(0.01, dt || 1));
    const F = [
      [1, 0, step, 0],
      [0, 1, 0, step],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ];
    const dt2 = step * step;
    const dt3 = dt2 * step;
    const dt4 = dt2 * dt2;
    const q = this.q;
    const Q = [
      [dt4 / 4 * q, 0, dt3 / 2 * q, 0],
      [0, dt4 / 4 * q, 0, dt3 / 2 * q],
      [dt3 / 2 * q, 0, dt2 * q, 0],
      [0, dt3 / 2 * q, 0, dt2 * q],
    ];
    this.x = matVec(F, this.x);
    this.P = matAdd(matMul(matMul(F, this.P), matTranspose(F)), Q);
  }

  /**
   * z: {x, y} in local metres. confidence: the fix's confidence
   * (0..1) — drives R. Returns the filtered {x, y}.
   */
  update(z, confidence) {
    if (!this.initialized) {
      this.reset(z.x, z.y);
      return { x: z.x, y: z.y };
    }
    const sigma = sigmaFromConfidence(confidence);
    const R = [
      [sigma * sigma, 0],
      [0, sigma * sigma],
    ];
    const H = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ];
    const Hx = matVec(H, this.x);
    const y = [z.x - Hx[0], z.y - Hx[1]];
    this.innovationM = Math.sqrt(y[0] * y[0] + y[1] * y[1]);
    const S = matAdd(matMul(matMul(H, this.P), matTranspose(H)), R);
    const K = matMul(matMul(this.P, matTranspose(H)), invert2x2(S));
    this.x = this.x.map((v, i) => v + K[i][0] * y[0] + K[i][1] * y[1]);
    const KH = matMul(K, H);
    this.P = matMul(matSub(matIdentity(4), KH), this.P);
    return { x: this.x[0], y: this.x[1] };
  }

  getPosition() {
    return { x: this.x[0], y: this.x[1] };
  }

  getVelocity() {
    return { vx: this.x[2], vy: this.x[3] };
  }
}

/** Box-Muller Gaussian from a () => [0,1) RNG. */
function gauss(rnd) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 2D segment intersection (including touching). */
function segmentsCross(a, b, c, d) {
  function orient(p, q, r) {
    const v = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    if (Math.abs(v) < 1e-12) return 0;
    return v > 0 ? 1 : -1;
  }
  function onSegment(p, q, r) {
    return (
      q.x >= Math.min(p.x, r.x) - 1e-9 &&
      q.x <= Math.max(p.x, r.x) + 1e-9 &&
      q.y >= Math.min(p.y, r.y) - 1e-9 &&
      q.y <= Math.max(p.y, r.y) + 1e-9
    );
  }
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, c, b)) return true;
  if (o2 === 0 && onSegment(a, d, b)) return true;
  if (o3 === 0 && onSegment(c, a, d)) return true;
  if (o4 === 0 && onSegment(c, b, d)) return true;
  return false;
}

/**
 * Does the straight segment prev -> next cross any polygon
 * boundary? prev/next are {lat,lon} (or {x,y} local metres when
 * polygons are given in the same local metres with ref=null).
 * polygons: arrays of [lat,lon] vertices, or {lat,lon} points.
 * ref: {lat,lon} for lat/lon input; pass null when everything is
 * already local metres. A crossing is an edge intersection OR a
 * change of inside/outside state.
 */
function killWallCrossers(prev, next, polygons, ref) {
  if (!polygons || !polygons.length) return false;
  const toXY = (p) => {
    if (ref) return WorldmapGeo.toLocalMeters(WorldmapGeo.latOf(p), WorldmapGeo.lonOf(p), ref.lat, WorldmapGeo.lonOf(ref));
    return { x: p.x, y: p.y };
  };
  const a = toXY(prev);
  const b = toXY(next);
  for (const poly of polygons) {
    const pts = poly.map(toXY);
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      if (segmentsCross(a, b, pts[j], pts[i])) return true;
    }
    const inA = pointInLocal(a, pts);
    const inB = pointInLocal(b, pts);
    if (inA !== inB) return true;
  }
  return false;
}

/** Point-in-polygon for local-metre {x,y} points. */
function pointInLocal(p, polyXY) {
  let inside = false;
  for (let i = 0, j = polyXY.length - 1; i < polyXY.length; j = i++) {
    const xi = polyXY[i].x;
    const yi = polyXY[i].y;
    const xj = polyXY[j].x;
    const yj = polyXY[j].y;
    const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

class ParticleFilter {
  /**
   * options: {count (default 200), seed (default 7),
   *   motionNoiseM (default 0.5), velocityNoise (default 0.3)}
   * init(point, spreadM): point {x,y} local metres.
   * polygons + ref are given to predict() for the wall constraint.
   */
  constructor(options) {
    const opts = options || {};
    this.count = opts.count || 200;
    this.motionNoiseM = typeof opts.motionNoiseM === 'number' ? opts.motionNoiseM : 0.5;
    this.velocityNoise = typeof opts.velocityNoise === 'number' ? opts.velocityNoise : 0.3;
    this.rng = WorldmapGeo.seeded(typeof opts.seed === 'number' ? opts.seed : 7);
    this.particles = [];
    this.initialized = false;
  }

  init(point, spreadM) {
    const spread = typeof spreadM === 'number' ? spreadM : 5;
    this.particles = [];
    for (let i = 0; i < this.count; i++) {
      this.particles.push({
        x: point.x + gauss(this.rng) * spread,
        y: point.y + gauss(this.rng) * spread,
        vx: gauss(this.rng) * 0.2,
        vy: gauss(this.rng) * 0.2,
        w: 1 / this.count,
      });
    }
    this.initialized = true;
  }

  /**
   * Advance the motion model. polygons: floor-plan polygons in
   * lat/lon; ref: {lat,lon} reference for the local-metre frame.
   * A particle whose step would cross a wall is reverted to its
   * previous position (killed) instead of teleporting through.
   */
  predict(dt, polygons, ref) {
    if (!this.initialized) return;
    const step = Math.min(5, Math.max(0.01, dt || 1));
    this.particles.forEach((p) => {
      const prev = { x: p.x, y: p.y };
      p.vx += gauss(this.rng) * this.velocityNoise * step;
      p.vy += gauss(this.rng) * this.velocityNoise * step;
      const nx = p.x + p.vx * step + gauss(this.rng) * this.motionNoiseM;
      const ny = p.y + p.vy * step + gauss(this.rng) * this.motionNoiseM;
      if (polygons && polygons.length && ref) {
        const prevLL = WorldmapGeo.fromLocalMeters(prev.x, prev.y, ref);
        const nextLL = WorldmapGeo.fromLocalMeters(nx, ny, ref);
        if (killWallCrossers(prevLL, nextLL, polygons, ref)) {
          p.vx = 0;
          p.vy = 0;
          return; // stay at prev — the wall kills the crossing.
        }
      }
      p.x = nx;
      p.y = ny;
    });
  }

  /**
   * Weight particles by distance to the latest fix {x,y},
   * then resample when the effective sample size is low.
   */
  update(fix, confidence) {
    if (!this.initialized) {
      this.init(fix, sigmaFromConfidence(confidence));
      return this.estimate();
    }
    const sigma = sigmaFromConfidence(confidence);
    let sum = 0;
    this.particles.forEach((p) => {
      const dx = p.x - fix.x;
      const dy = p.y - fix.y;
      p.w *= Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
      sum += p.w;
    });
    if (sum <= 0 || !Number.isFinite(sum)) {
      this.particles.forEach((p) => {
        p.w = 1 / this.count;
      });
      return this.estimate();
    }
    this.particles.forEach((p) => {
      p.w /= sum;
    });
    let ess = 0;
    this.particles.forEach((p) => {
      ess += p.w * p.w;
    });
    ess = 1 / ess;
    if (ess < this.count / 2) this.resample();
    return this.estimate();
  }

  /** Systematic resampling. */
  resample() {
    const n = this.particles.length;
    const out = [];
    const start = this.rng() / n;
    let c = this.particles[0].w;
    let i = 0;
    for (let m = 0; m < n; m++) {
      const u = start + m / n;
      while (u > c && i < n - 1) {
        i++;
        c += this.particles[i].w;
      }
      const src = this.particles[i];
      out.push({ x: src.x, y: src.y, vx: src.vx, vy: src.vy, w: 1 / n });
    }
    this.particles = out;
  }

  estimate() {
    let sx = 0;
    let sy = 0;
    let sw = 0;
    this.particles.forEach((p) => {
      sx += p.x * p.w;
      sy += p.y * p.w;
      sw += p.w;
    });
    if (!sw) return { x: 0, y: 0 };
    return { x: sx / sw, y: sy / sw };
  }
}

const WorldmapFilter = {
  KalmanFilter2D,
  ParticleFilter,
  sigmaFromConfidence,
  killWallCrossers,
  segmentsCross,
};

if (typeof window !== 'undefined') window.WorldmapFilter = WorldmapFilter;
