/**
 * Geographic helpers used by both the fetcher and the tests.
 * All coordinates are [lng, lat] arrays to match GeoJSON.
 */

const EARTH_RADIUS_M = 6371008.8;
const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;

const toRad = (deg) => (deg * PI) / 180;

/** Great-circle distance in metres between two [lng, lat] points. */
export function haversineMeters(a, b) {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Total length of a [lng, lat] polyline, in metres. */
export function pathLengthMeters(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineMeters(points[i - 1], points[i]);
  return total;
}

/** Local equirectangular projection to metres, anchored at the mean latitude. */
function project(points) {
  let sumLat = 0;
  for (const p of points) sumLat += p[1];
  const lat0 = sumLat / Math.max(1, points.length);
  const kx = 111320 * Math.cos(toRad(lat0));
  const ky = 110540;
  return points.map(([lng, lat]) => [lng * kx, lat * ky]);
}

function squaredSegmentDistance(p, a, b) {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

/** Iterative Douglas–Peucker, returns indices to keep. */
function douglasPeucker(projected, tolerance) {
  const n = projected.length;
  if (n <= 2) return [0, n - 1];
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = tolerance * tolerance;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist2 = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d2 = squaredSegmentDistance(projected[i], projected[first], projected[last]);
      if (d2 > maxDist2) {
        maxDist2 = d2;
        index = i;
      }
    }
    if (maxDist2 > tol2 && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * Simplify a [lng, lat] polyline.
 * Tolerance is in metres; maxPoints is a hard cap (tolerance is loosened if needed).
 */
export function simplifyLine(points, toleranceMeters = 4, maxPoints = 1200) {
  if (!Array.isArray(points) || points.length <= 2) return points ? points.slice() : [];
  const clean = [];
  for (const p of points) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const lng = Number(p[0]);
    const lat = Number(p[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    if (lat === 0 && lng === 0) continue;
    if (clean.length) {
      const prev = clean[clean.length - 1];
      if (haversineMeters(prev, [lng, lat]) < 0.4) continue;
    }
    clean.push([lng, lat]);
  }
  if (clean.length <= 2) return clean;

  const projected = project(clean);
  let tolerance = Math.max(0.5, toleranceMeters);
  let indices = douglasPeucker(projected, tolerance);
  let guard = 0;
  while (indices.length > maxPoints && guard < 8) {
    tolerance *= 1.7;
    indices = douglasPeucker(projected, tolerance);
    guard++;
  }
  if (indices.length > maxPoints) {
    const step = (indices.length - 1) / (maxPoints - 1);
    const sampled = [];
    for (let i = 0; i < maxPoints; i++) sampled.push(indices[Math.round(i * step)]);
    indices = [...new Set(sampled)];
  }
  return indices.map((i) => clean[i]);
}

export function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/** WGS-84 -> GCJ-02. Input/output [lng, lat]. */
export function wgs84ToGcj02(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return [lng + dLng, lat + dLat];
}

/** GCJ-02 -> WGS-84, iterative inverse. Input/output [lng, lat]. */
export function gcj02ToWgs84(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  let wLng = lng;
  let wLat = lat;
  for (let i = 0; i < 4; i++) {
    const [gLng, gLat] = wgs84ToGcj02(wLng, wLat);
    wLng += lng - gLng;
    wLat += lat - gLat;
  }
  return [wLng, wLat];
}

/** Format metres as a human readable distance (used by tests/CLI logs). */
export function formatMeters(meters) {
  if (!Number.isFinite(meters)) return '—';
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}
