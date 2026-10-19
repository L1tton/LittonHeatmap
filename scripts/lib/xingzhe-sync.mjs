/**
 * Server-side 行者 sync core.
 *
 * The official OAuth API only exposes activity metadata, not track points.
 * This module uses the user's own web session cookie for a single request,
 * only fetches that account's own records, and never writes the cookie or
 * tracks to disk.
 */
import { parseGpx } from './gpx.mjs';
import { simplifyLine, haversineMeters } from './geo.mjs';

const BASE = 'https://www.imxingzhe.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_POINTS = 1200;

export class AuthError extends Error {}
export class NoTracksError extends Error {}
export class RateLimitError extends Error {}
export class UpstreamError extends Error {}

const RANGE_LABELS = { '1y': '最近 1 年', '3y': '最近 3 年', all: '全部历史' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeRange(value) {
  return value === '1y' || value === '3y' || value === 'all' ? value : '1y';
}

function rangeStartMonth(range) {
  if (range === 'all') return '2012-01';
  const monthsBack = range === '3y' ? 35 : 11;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
}

function abortError() {
  const error = new Error('同步已取消');
  error.name = 'AbortError';
  return error;
}

function monthList(from, to) {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  const list = [];
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    list.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return list;
}

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function request(url, { cookie, signal, binary = false, retries = 1 } = {}) {
  let attempt = 0;
  for (;;) {
    attempt++;
    if (signal?.aborted) throw abortError();
    const timeout = AbortSignal.timeout(25000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Cookie: cookie,
          Referer: 'https://www.imxingzhe.com/',
          Accept: binary ? '*/*' : 'application/json, text/plain, */*',
        },
        signal: combined,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        if (signal?.aborted) throw abortError();
        if (attempt > retries) throw new Error('行者请求超时');
        await sleep(1500);
        continue;
      }
      if (attempt > retries) throw new Error('无法连接行者服务器');
      await sleep(1500);
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new AuthError('行者登录态已失效，请重新登录后再同步');
    }
    if (response.status === 429) {
      throw new RateLimitError(
        '行者触发了访问频率限制。请停止同步，等待 15–30 分钟后再试；也可以改用 GPX / FIT 导入。',
      );
    }
    if (response.status >= 500) {
      throw new UpstreamError(`行者服务暂时不可用（HTTP ${response.status}），请稍后再试`);
    }
    if (!response.ok) throw new Error(`行者请求失败（HTTP ${response.status}）`);
    return binary ? Buffer.from(await response.arrayBuffer()) : await response.text();
  }
}

async function apiJson(url, options) {
  const text = await request(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('行者返回了无法解析的数据');
  }
}

function unwrapUser(json) {
  const node = json && json.data && (json.data.userid || json.data.id) ? json.data : json;
  if (!node || !(node.userid || node.id)) throw new AuthError('无法读取行者账号信息');
  return {
    id: node.userid || node.id,
    name: String(node.username || '').trim(),
    totalMeters: Number(node.total_distance) || 0,
  };
}

function unixParts(value) {
  let ms = Number(value);
  if (!Number.isFinite(ms)) return null;
  if (ms < 1e12) ms *= 1000;
  const shifted = new Date(ms + 8 * 3600 * 1000);
  if (Number.isNaN(shifted.getTime())) return null;
  const iso = shifted.toISOString().replace('Z', '+08:00');
  return { iso, date: iso.slice(0, 10), year: Number(iso.slice(0, 4)) };
}

/**
 * Sync the account identified by the cookie.
 * Progress events:
 *   { type:'range', range, label, months }
 *   { type:'user', user }
 *   { type:'progress', phase:'months', current, total, found }
 *   { type:'progress', phase:'tracks', current, total, title }
 */
export async function syncOwnData({
  cookie,
  signal,
  onEvent = () => {},
  maxTracks = 1500,
  range = '1y',
} = {}) {
  const selectedRange = normalizeRange(range);
  const info = unwrapUser(
    await apiJson(`${BASE}/api/v4/account/get_user_info/`, { cookie, signal }),
  );
  onEvent({ type: 'user', user: { id: info.id, name: info.name } });

  const months = monthList(rangeStartMonth(selectedRange), currentMonth());
  onEvent({
    type: 'range',
    range: selectedRange,
    label: RANGE_LABELS[selectedRange],
    months: months.length,
  });

  const workouts = new Map();
  const mergedIds = new Set();
  const monthErrors = [];
  let mergedSkipped = 0;

  for (let i = 0; i < months.length; i++) {
    if (signal?.aborted) throw abortError();
    const month = months[i];
    const [year, monthNumber] = month.split('-');
    try {
      const json = await apiJson(
        `${BASE}/api/v4/user_month_info/?user_id=${info.id}&year=${year}&month=${monthNumber}`,
        { cookie, signal },
      );
      const list = json?.data?.wo_info;
      if (Array.isArray(list)) {
        for (const item of list) {
          if (!item?.id || workouts.has(item.id)) continue;
          const title = String(item.title || '').trim() || '未命名记录';
          // 行者把多次记录合并成一条时会在标题里写“合并”；
          // 原始分段记录也会出现在列表里，保留合并记录会导致轨迹重复。
          if (title.includes('合并')) {
            if (!mergedIds.has(item.id)) {
              mergedIds.add(item.id);
              mergedSkipped++;
            }
            continue;
          }
          workouts.set(item.id, {
            id: item.id,
            title,
            start: item.start_time,
            end: item.end_time,
            distance: Number(item.distance) || 0,
          });
        }
      }
    } catch (err) {
      if (
        err instanceof AuthError ||
        err instanceof RateLimitError ||
        err instanceof UpstreamError ||
        err.name === 'AbortError'
      ) {
        throw err;
      }
      monthErrors.push(month);
      if (monthErrors.length >= 8) {
        throw new Error('行者接口连续失败，请稍后再试');
      }
    }
    onEvent({
      type: 'progress',
      phase: 'months',
      current: i + 1,
      total: months.length,
      found: workouts.size,
      merged: mergedSkipped,
    });
    await sleep(450 + Math.floor(Math.random() * 250));
  }

  const all = [...workouts.values()].sort((a, b) => Number(a.start) - Number(b.start));
  if (all.length === 0) {
    throw new NoTracksError('所选范围内没有找到带 GPS 的运动记录，试试更大的同步范围');
  }

  const queue = all.slice(0, maxTracks);
  const features = [];
  let skipped = 0;

  for (let i = 0; i < queue.length; i++) {
    if (signal?.aborted) throw abortError();
    const workout = queue[i];
    const time = unixParts(workout.start);
    if (!time) {
      skipped++;
      continue;
    }
    try {
      const buffer = await request(`${BASE}/api/v1/pgworkout/${workout.id}/gpx/`, {
        cookie,
        signal,
        binary: true,
      });
      const parsed = parseGpx(buffer.toString('utf8'));
      const points = simplifyLine(parsed.points, 4, MAX_POINTS);
      const coordinates = [];
      for (const [lng, lat] of points) {
        const point = [Math.round(lng * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];
        const last = coordinates[coordinates.length - 1];
        if (last && last[0] === point[0] && last[1] === point[1]) continue;
        coordinates.push(point);
      }
      if (coordinates.length < 2) {
        skipped++;
        continue;
      }
      let meters = workout.distance;
      if (!(meters > 0)) {
        meters = 0;
        for (let j = 1; j < parsed.points.length; j++) {
          meters += haversineMeters(parsed.points[j - 1], parsed.points[j]);
        }
      }
      const durationMin =
        workout.end && workout.start
          ? Math.max(0, Math.round((Number(workout.end) - Number(workout.start)) / 60000))
          : 0;
      features.push({
        type: 'Feature',
        properties: {
          id: workout.id,
          title: workout.title,
          date: time.date,
          start: time.iso,
          year: time.year,
          distanceKm: Math.round((meters / 1000) * 100) / 100,
          durationMin,
          source: 'xingzhe',
        },
        geometry: { type: 'LineString', coordinates },
      });
    } catch (err) {
      if (
        err instanceof AuthError ||
        err instanceof RateLimitError ||
        err.name === 'AbortError'
      ) {
        throw err;
      }
      skipped++;
    }

    onEvent({
      type: 'progress',
      phase: 'tracks',
      current: i + 1,
      total: queue.length,
      title: workout.title,
    });
    await sleep(600 + Math.floor(Math.random() * 300));
  }

  if (features.length === 0) {
    throw new NoTracksError('所选范围内没有可用的 GPS 轨迹（可能都是室内记录）');
  }

  features.sort((a, b) => a.properties.start.localeCompare(b.properties.start));
  const yearsMap = new Map();
  let distanceKm = 0;
  let pointCount = 0;
  let firstDate = features[0].properties.date;
  let lastDate = firstDate;
  for (const feature of features) {
    const p = feature.properties;
    distanceKm += p.distanceKm;
    pointCount += feature.geometry.coordinates.length;
    if (p.date < firstDate) firstDate = p.date;
    if (p.date > lastDate) lastDate = p.date;
    if (!yearsMap.has(p.year)) yearsMap.set(p.year, { year: p.year, count: 0, distanceKm: 0 });
    const entry = yearsMap.get(p.year);
    entry.count++;
    entry.distanceKm += p.distanceKm;
  }

  const years = [...yearsMap.values()]
    .map((entry) => ({ ...entry, distanceKm: Math.round(entry.distanceKm * 10) / 10 }))
    .sort((a, b) => a.year - b.year);

  const manifest = {
    user: { id: info.id, name: info.name },
    generatedAt: new Date().toISOString(),
    source: 'xingzhe',
    datum: 'wgs84',
    range: selectedRange,
    rangeLabel: RANGE_LABELS[selectedRange],
    rangeStart: months[0],
    monthsScanned: months.length,
    stats: {
      activities: features.length,
      distanceKm: Math.round(distanceKm * 10) / 10,
      firstDate,
      lastDate,
      years: years.map((entry) => entry.year),
      points: pointCount,
    },
    years,
    skipped: {
      totalWorkouts: all.length + mergedSkipped,
      merged: mergedSkipped,
      notFetched: Math.max(0, all.length - queue.length),
      failed: skipped,
      monthErrors: monthErrors.length,
    },
    truncated: all.length > queue.length,
  };

  return { user: { id: info.id, name: info.name }, manifest, features };
}
