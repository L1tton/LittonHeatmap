/**
 * Browser-side GPX parsing and feature building.
 * 行者 exports, Garmin/Strava GPX and most device GPX files are supported.
 */
import { simplifyLine, pathLengthMeters } from './geo.js';

export class GpxParseError extends Error {}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function parsePoints(block) {
  const points = [];
  const re = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/gi;
  let match;
  while ((match = re.exec(block))) {
    const attrs = match[1] || '';
    const body = match[2] || '';
    const latMatch = /\blat\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const lonMatch = /\blon\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (!latMatch || !lonMatch) continue;
    const lat = Number(latMatch[1]);
    const lon = Number(lonMatch[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (lat === 0 && lon === 0) continue;
    const timeMatch = /<time>\s*([^<]+?)\s*<\/time>/i.exec(body);
    const last = points[points.length - 1];
    if (last && last.lon === lon && last.lat === lat) continue;
    points.push({ lon, lat, time: timeMatch ? timeMatch[1] : null });
  }
  return points;
}

/**
 * Parse a GPX document into one or more coordinate segments.
 * Returns { name, segments: [[lng,lat],...], startTime, endTime }.
 */
export function parseGpx(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw new GpxParseError('文件为空');
  if (/<!doctype\s+html|<html[\s>]/i.test(xml.slice(0, 500))) {
    throw new GpxParseError('这是网页而不是 GPX 文件');
  }

  const nameMatch =
    /<trk>[\s\S]*?<name>\s*([\s\S]*?)\s*<\/name>/i.exec(xml) ||
    /<metadata>[\s\S]*?<name>\s*([\s\S]*?)\s*<\/name>/i.exec(xml);
  const metadataTime = /<metadata>[\s\S]*?<time>\s*([^<]+?)\s*<\/time>/i.exec(xml);

  const segments = [];
  const segRe = /<trkseg\b[^>]*>([\s\S]*?)<\/trkseg>/gi;
  let match;
  while ((match = segRe.exec(xml))) {
    const pts = parsePoints(match[1]);
    if (pts.length >= 2) segments.push(pts);
  }
  if (segments.length === 0) {
    const pts = parsePoints(xml);
    if (pts.length >= 2) segments.push(pts);
  }
  if (segments.length === 0) throw new GpxParseError('没有找到有效的轨迹点');

  const all = segments.flat();
  const times = all.map((p) => p.time).filter(Boolean);
  const startTime = metadataTime ? metadataTime[1] : times[0] || null;
  const endTime = times.length > 1 ? times[times.length - 1] : null;

  return {
    name: nameMatch ? decodeXml(nameMatch[1]).replace(/\s+/g, ' ').trim() : '',
    segments: segments.map((seg) => seg.map((p) => [p.lon, p.lat])),
    startTime,
    endTime,
  };
}

function round5(value) {
  return Math.round(value * 1e5) / 1e5;
}

function localDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Convert one GPX File into one or more GeoJSON features. */
export async function gpxFileToFeatures(file, { maxPoints = 1200 } = {}) {
  const text = await file.text();
  const parsed = parseGpx(text);

  const start = parsed.startTime ? new Date(parsed.startTime) : null;
  const validStart = start && !Number.isNaN(start.getTime()) ? start : null;
  const fallback = new Date(file.lastModified || Date.now());
  const date = localDate(validStart || fallback);
  const year = Number(date.slice(0, 4));
  const startIso = (validStart || fallback).toISOString();

  const baseTitle = (parsed.name || file.name.replace(/\.gpx$/i, '')).trim().slice(0, 90) || '未命名轨迹';
  const features = [];

  parsed.segments.forEach((segment, index) => {
    const coordinates = simplifyLine(segment, 4, maxPoints).map(([lng, lat]) => [round5(lng), round5(lat)]);
    if (coordinates.length < 2) return;
    const meters = pathLengthMeters(segment);
    const importKey = `${file.name}|${file.size}|${file.lastModified || 0}|${index}`;
    const feature = {
      type: 'Feature',
      properties: {
        id: `gpx-${hashString(importKey)}`,
        title: parsed.segments.length > 1 ? `${baseTitle} (${index + 1})` : baseTitle,
        date,
        start: startIso,
        year,
        distanceKm: Math.round((meters / 1000) * 100) / 100,
        durationMin: 0,
        source: 'gpx',
        importKey,
      },
      geometry: { type: 'LineString', coordinates },
    };
    if (parsed.segments.length === 1 && validStart && parsed.endTime) {
      const end = new Date(parsed.endTime);
      if (!Number.isNaN(end.getTime()) && end > validStart) {
        feature.properties.durationMin = Math.max(0, Math.round((end - validStart) / 60000));
      }
    }
    features.push(feature);
  });

  if (features.length === 0) throw new GpxParseError('轨迹点太少，无法绘制');
  return features;
}
