/**
 * Browser-side FIT import.
 * Uses the bundled fit-file-parser (MIT) and returns the same feature shape as GPX.
 */
import FitParser from './vendor/fit-parser.js';
import { simplifyLine, pathLengthMeters } from './geo.js';

export class FitParseError extends Error {}

function round5(value) {
  return Math.round(value * 1e5) / 1e5;
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function localDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function asDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/** Convert one FIT File into a GeoJSON feature. */
export async function fitFileToFeatures(file, { maxPoints = 1200 } = {}) {
  let data;
  try {
    const buffer = await file.arrayBuffer();
    const parser = new FitParser({
      force: true,
      mode: 'list',
      speedUnit: 'm/s',
      lengthUnit: 'm',
      elapsedRecordField: true,
    });
    data = await parser.parseAsync(buffer);
  } catch (err) {
    throw new FitParseError(`FIT 解析失败：${err.message || '文件格式不正确'}`);
  }

  const records = Array.isArray(data?.records) ? data.records : [];
  const session = Array.isArray(data?.sessions) ? data.sessions[0] || {} : {};
  const points = [];

  for (const record of records) {
    let lat = Number(record.position_lat);
    let lon = Number(record.position_long);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // fit-file-parser normally returns degrees; tolerate raw semicircles.
    if (Math.abs(lat) > 90) lat *= 180 / 2 ** 31;
    if (Math.abs(lon) > 180) lon *= 180 / 2 ** 31;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (lat === 0 && lon === 0) continue;
    const last = points[points.length - 1];
    if (last && last[0] === lon && last[1] === lat) continue;
    points.push([lon, lat]);
  }

  if (points.length < 2) {
    throw new FitParseError('FIT 文件里没有有效的 GPS 轨迹点');
  }

  const simplified = simplifyLine(points, 4, maxPoints).map(([lng, lat]) => [round5(lng), round5(lat)]);
  const sessionStart = asDate(session.start_time);
  const firstTimestamp = records.map((record) => asDate(record.timestamp)).find(Boolean);
  const lastTimestamp = [...records].reverse().map((record) => asDate(record.timestamp)).find(Boolean);
  const start = sessionStart || firstTimestamp || new Date(file.lastModified || Date.now());
  const date = localDate(start);
  const year = Number(date.slice(0, 4));

  let meters = Number(session.total_distance);
  if (!(meters > 0)) meters = pathLengthMeters(points);

  let durationMin = 0;
  if (Number(session.total_elapsed_time) > 0) {
    durationMin = Math.round(Number(session.total_elapsed_time) / 60);
  } else if (Number(session.total_timer_time) > 0) {
    durationMin = Math.round(Number(session.total_timer_time) / 60);
  } else if (firstTimestamp && lastTimestamp && lastTimestamp > firstTimestamp) {
    durationMin = Math.round((lastTimestamp - firstTimestamp) / 60000);
  }

  const title = file.name.replace(/\.fit$/i, '').trim().slice(0, 90) || 'FIT 轨迹';
  const importKey = `${file.name}|${file.size}|${file.lastModified || 0}|0`;

  return [
    {
      type: 'Feature',
      properties: {
        id: `fit-${hashString(importKey)}`,
        title,
        date,
        start: start.toISOString(),
        year,
        distanceKm: Math.round((meters / 1000) * 100) / 100,
        durationMin,
        source: 'fit',
        importKey,
      },
      geometry: { type: 'LineString', coordinates: simplified },
    },
  ];
}
