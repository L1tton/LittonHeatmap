/**
 * Minimal, dependency-free GPX trackpoint parser.
 * 行者's /xing/{id}/gpx endpoint returns a normal GPX 1.1 document once logged in.
 */

export class GpxParseError extends Error {}

/**
 * Parse a GPX document into { points: [[lng, lat], ...] }.
 * Throws GpxParseError when the response is obviously not a GPX (e.g. a login page).
 */
export function parseGpx(xml) {
  if (typeof xml !== 'string' || !xml.trim()) {
    throw new GpxParseError('GPX 内容为空');
  }
  const head = xml.slice(0, 800);
  const trkptRe = /<trkpt\b([^>]*)>/gi;
  const points = [];
  let match;
  while ((match = trkptRe.exec(xml))) {
    const attrs = match[1];
    const latMatch = /\blat\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const lonMatch = /\blon\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (!latMatch || !lonMatch) continue;
    const lat = Number(latMatch[1]);
    const lon = Number(lonMatch[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (lat === 0 && lon === 0) continue;
    const last = points[points.length - 1];
    if (last && last[0] === lon && last[1] === lat) continue;
    points.push([lon, lat]);
  }

  if (points.length === 0) {
    if (/<!doctype\s+html|<html[\s>]/i.test(head) || /登录以后才能导出|请登录|login/i.test(head)) {
      throw new GpxParseError('行者返回了登录页而不是 GPX，请重新登录');
    }
    throw new GpxParseError('GPX 中没有有效的轨迹点');
  }
  return { points };
}
