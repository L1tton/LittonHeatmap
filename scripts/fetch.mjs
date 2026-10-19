#!/usr/bin/env node
/**
 * Fetch all L1tton workouts from 行者 (imxingzhe.com), download each GPX,
 * simplify the tracks and write per-year GeoJSON files for the web map.
 *
 * Requires .cache/cookie.txt produced by `npm run login`.
 *
 * Usage:
 *   node scripts/fetch.mjs                 # all months, resumable
 *   node scripts/fetch.mjs --from=2026-01 --to=2026-01 --max=3
 *   node scripts/fetch.mjs --force
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGpx, GpxParseError } from './lib/gpx.mjs';
import { haversineMeters, simplifyLine } from './lib/geo.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.cache');
const GPX_CACHE = path.join(CACHE, 'gpx');
const MONTH_CACHE = path.join(CACHE, 'months');
const COOKIE_FILE = path.join(CACHE, 'cookie.txt');
const DATA_DIR = path.join(ROOT, 'web', 'data');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BASE = 'https://www.imxingzhe.com';
const TARGET_NAME = 'l1tton';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { force: false, max: Infinity, allowUser: false, from: '2012-01', to: null };
  for (const arg of argv) {
    if (arg === '--force') out.force = true;
    else if (arg === '--allow-user') out.allowUser = true;
    else if (arg.startsWith('--from=')) out.from = arg.slice(7);
    else if (arg.startsWith('--to=')) out.to = arg.slice(5);
    else if (arg.startsWith('--max=')) out.max = Math.max(1, Number(arg.slice(6)) || Infinity);
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(1);
    }
  }
  if (!/^\d{4}-\d{2}$/.test(out.from)) throw new Error('--from 需要 YYYY-MM 格式');
  if (out.to && !/^\d{4}-\d{2}$/.test(out.to)) throw new Error('--to 需要 YYYY-MM 格式');
  return out;
}

function monthList(from, to) {
  const [fy, fm] = from.split('-').map(Number);
  const now = new Date();
  const end = to ? to.split('-').map(Number) : [now.getFullYear(), now.getMonth() + 1];
  const list = [];
  let y = fy;
  let m = fm;
  while (y < end[0] || (y === end[0] && m <= end[1])) {
    list.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return list;
}

class AuthError extends Error {}

async function request(url, { retries = 3, binary = false } = {}) {
  let attempt = 0;
  for (;;) {
    attempt++;
    let res;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Cookie: COOKIE,
          Referer: 'https://www.imxingzhe.com/',
          Accept: binary ? '*/*' : 'application/json, text/plain, */*',
        },
      });
    } catch (err) {
      if (attempt > retries) throw new Error(`网络请求失败：${url}（${err.message}）`);
      await sleep(1200 * attempt);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`行者拒绝访问（HTTP ${res.status}）。Cookie 可能已失效，请运行 npm run login。`);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt > retries) throw new Error(`行者服务异常（HTTP ${res.status}）：${url}`);
      const wait = 1500 * 2 ** (attempt - 1);
      console.log(`  · HTTP ${res.status}，${(wait / 1000).toFixed(1)}s 后重试（${attempt}/${retries}）`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`请求失败（HTTP ${res.status}）：${url}`);
    return binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
  }
}

async function apiJson(url) {
  const text = await request(url);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`接口返回的不是 JSON：${url}\n${text.slice(0, 200)}`);
  }
}

function unwrapUser(json) {
  const node = json && json.data && (json.data.userid || json.data.id) ? json.data : json;
  if (!node || !(node.userid || node.id)) throw new AuthError('无法读取用户信息（Cookie 可能已失效）');
  return { id: node.userid || node.id, name: (node.username || '').trim(), totalMeters: node.total_distance || 0 };
}

function unixParts(value) {
  let ms = Number(value);
  if (!Number.isFinite(ms)) return null;
  if (ms < 1e12) ms *= 1000;
  const shifted = new Date(ms + 8 * 3600 * 1000);
  if (Number.isNaN(shifted.getTime())) return null;
  const iso = shifted.toISOString().replace('Z', '+08:00');
  return { ms, iso, date: iso.slice(0, 10), year: Number(iso.slice(0, 4)) };
}

async function writeAtomic(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, content);
  await fsp.rename(tmp, file);
}

async function readCookie() {
  let cookie = '';
  try {
    cookie = (await fsp.readFile(COOKIE_FILE, 'utf8')).trim();
  } catch {
    console.error('✗ 找不到 .cache/cookie.txt。请先运行：npm run login');
    process.exit(2);
  }
  if (!cookie) {
    console.error('✗ Cookie 为空。请先运行：npm run login');
    process.exit(2);
  }
  return cookie.replace(/\r?\n/g, '');
}

const args = parseArgs(process.argv.slice(2));
const COOKIE = await readCookie();
await fsp.mkdir(GPX_CACHE, { recursive: true });
await fsp.mkdir(MONTH_CACHE, { recursive: true });
await fsp.mkdir(DATA_DIR, { recursive: true });

const startedAt = Date.now();

// 1. Verify the logged in account.
let user;
try {
  user = unwrapUser(await apiJson(`${BASE}/api/v4/account/get_user_info/`));
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(2);
}
console.log(`✓ 登录账号：${user.name || '(未命名)'} (uid=${user.id})`);
if (user.name.toLowerCase() !== TARGET_NAME && !args.allowUser) {
  console.error(`✗ 当前账号不是 L1tton（实际：${user.name}）。`);
  console.error('  请退出后重新登录 L1tton，或确认身份后加 --allow-user。');
  process.exit(2);
}

// 2. Collect workout metadata month by month.
const months = monthList(args.from, args.to || monthListEnd());
console.log(`· 读取 ${months[0]} → ${months[months.length - 1]} 的运动列表…`);

const workouts = new Map();
let emptyMonths = 0;
let mergedSkipped = 0;
let mergedMeters = 0;
const monthErrors = [];

for (const month of months) {
  const cacheFile = path.join(MONTH_CACHE, `${month}.json`);
  let json;
  try {
    if (!args.force && fs.existsSync(cacheFile)) {
      json = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
    } else {
      const [y, m] = month.split('-');
      json = await apiJson(`${BASE}/api/v4/user_month_info/?user_id=${user.id}&year=${y}&month=${m}`);
      await writeAtomic(cacheFile, JSON.stringify(json));
      await sleep(220);
    }
  } catch (err) {
    if (err instanceof AuthError) {
      console.error(`✗ ${err.message}`);
      process.exit(2);
    }
    monthErrors.push(`${month}: ${err.message}`);
    console.log(`  ! ${month} 读取失败：${err.message}`);
    continue;
  }

  const list = json && json.data && Array.isArray(json.data.wo_info) ? json.data.wo_info : [];
  if (list.length === 0) {
    emptyMonths++;
    continue;
  }
  for (const item of list) {
    if (!item || !item.id) continue;
    const title = (item.title || '').trim() || '未命名记录';
    if (title.includes('合并')) {
      mergedSkipped++;
      mergedMeters += Number(item.distance) || 0;
      continue;
    }
    if (!workouts.has(item.id)) {
      workouts.set(item.id, {
        id: item.id,
        title,
        start: item.start_time,
        end: item.end_time,
        distance: Number(item.distance) || 0,
        avgSpeed: Number(item.avg_speed) || 0,
      });
    }
  }
  console.log(`  ${month}  ${list.length} 条`);
}

if (monthErrors.length) {
  console.log(`\n⚠ ${monthErrors.length} 个月份读取失败（已跳过）：`);
  for (const e of monthErrors.slice(0, 10)) console.log(`  - ${e}`);
}

const allWorkouts = [...workouts.values()].sort((a, b) => Number(a.start) - Number(b.start));
console.log(`\n✓ 共 ${allWorkouts.length} 条运动记录（${emptyMonths} 个空月份）`);
if (mergedSkipped > 0) {
  console.log(`· 已跳过 ${mergedSkipped} 条标题带“合并”的记录，避免与原始分段记录重复`);
}
if (allWorkouts.length === 0) {
  console.error('✗ 没有取到任何运动记录，已停止。请检查账号隐私设置或 Cookie。');
  process.exit(2);
}

// 3. Download and simplify GPX tracks.
const features = [];
const byYear = new Map();
const skipped = { noGps: 0, parseFailed: 0, failed: 0, tooShort: 0 };
let done = 0;
let bytes = 0;

const queue = allWorkouts.slice(0, Number.isFinite(args.max) ? args.max : allWorkouts.length);

for (const workout of queue) {
  done++;
  const time = unixParts(workout.start);
  if (!time) {
    skipped.parseFailed++;
    continue;
  }
  const gpxFile = path.join(GPX_CACHE, `${workout.id}.gpx`);
  let xml;
  let fromCache = false;
  try {
    if (!args.force && fs.existsSync(gpxFile)) {
      xml = await fsp.readFile(gpxFile, 'utf8');
      fromCache = true;
    } else {
      const buf = await request(`${BASE}/api/v1/pgworkout/${workout.id}/gpx/`, { binary: true });
      xml = buf.toString('utf8');
      await sleep(360 + Math.floor(Math.random() * 240));
    }
  } catch (err) {
    if (err instanceof AuthError) {
      console.error(`\n✗ ${err.message}`);
      process.exit(2);
    }
    skipped.failed++;
    console.log(`  ! ${time.date} #${workout.id} 下载失败：${err.message}`);
    continue;
  }

  let parsed;
  try {
    parsed = parseGpx(xml);
    if (!fromCache && xml.trim()) await fsp.writeFile(gpxFile, xml);
  } catch (err) {
    if (err instanceof GpxParseError && /登录/.test(err.message)) {
      console.error(`\n✗ ${err.message}`);
      process.exit(2);
    }
    skipped.parseFailed++;
    if (skipped.parseFailed <= 5) console.log(`  ! ${time.date} #${workout.id} 解析失败：${err.message}`);
    continue;
  }

  if (parsed.points.length < 2) {
    skipped.noGps++;
    continue;
  }

  const simplified = simplifyLine(parsed.points, 4, 1200);
  const coordinates = [];
  for (const [lng, lat] of simplified) {
    const p = [Math.round(lng * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];
    const last = coordinates[coordinates.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    coordinates.push(p);
  }
  if (coordinates.length < 2) {
    skipped.tooShort++;
    continue;
  }

  let meters = workout.distance;
  if (!(meters > 0)) {
    meters = 0;
    for (let i = 1; i < parsed.points.length; i++) meters += haversineMeters(parsed.points[i - 1], parsed.points[i]);
  }
  const durationMin =
    workout.end && workout.start ? Math.max(0, Math.round((Number(workout.end) - Number(workout.start)) / 60000)) : 0;

  const feature = {
    type: 'Feature',
    properties: {
      id: workout.id,
      title: workout.title,
      date: time.date,
      start: time.iso,
      year: time.year,
      distanceKm: Math.round((meters / 1000) * 100) / 100,
      durationMin,
    },
    geometry: { type: 'LineString', coordinates },
  };
  features.push(feature);
  if (!byYear.has(time.year)) byYear.set(time.year, []);
  byYear.get(time.year).push(feature);
  bytes += JSON.stringify(feature).length;

  if (done % 10 === 0 || done === queue.length) {
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = done / Math.max(1, elapsed);
    const eta = rate > 0 ? Math.round((queue.length - done) / rate) : 0;
    console.log(`  [${done}/${queue.length}] ${time.date} ${workout.title.slice(0, 24)} (${coordinates.length} pts) · 剩余约 ${eta}s`);
  }
}

if (features.length === 0) {
  console.error('\n✗ 没有任何可用轨迹，未写入数据。');
  process.exit(2);
}

// 4. Write per-year GeoJSON + manifest.
features.sort((a, b) => a.properties.start.localeCompare(b.properties.start));
let totalKm = 0;
let totalPoints = 0;
const yearIndex = [];

for (const year of [...byYear.keys()].sort((a, b) => a - b)) {
  const list = byYear.get(year).sort((a, b) => a.properties.start.localeCompare(b.properties.start));
  const collection = { type: 'FeatureCollection', year, features: list };
  const file = `tracks-${year}.json`;
  const content = JSON.stringify(collection);
  await writeAtomic(path.join(DATA_DIR, file), content);
  const km = list.reduce((sum, f) => sum + f.properties.distanceKm, 0);
  totalKm += km;
  const points = list.reduce((sum, f) => sum + f.geometry.coordinates.length, 0);
  totalPoints += points;
  yearIndex.push({
    year,
    count: list.length,
    distanceKm: Math.round(km * 10) / 10,
    points,
    file,
    bytes: Buffer.byteLength(content),
  });
}

const dates = features.map((f) => f.properties.date).sort();
const manifest = {
  user: { id: user.id, name: user.name },
  generatedAt: new Date().toISOString(),
  source: 'https://www.imxingzhe.com',
  datum: 'wgs84',
  stats: {
    activities: features.length,
    distanceKm: Math.round(totalKm * 10) / 10,
    firstDate: dates[0],
    lastDate: dates[dates.length - 1],
    years: yearIndex.map((y) => y.year),
    points: totalPoints,
  },
  years: yearIndex,
  skipped: {
    ...skipped,
    merged: mergedSkipped,
    totalWorkouts: allWorkouts.length + mergedSkipped,
    notFetched: Math.max(0, allWorkouts.length - queue.length),
    emptyMonths,
    monthErrors: monthErrors.length,
  },
};
await writeAtomic(path.join(DATA_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
const mb = (yearIndex.reduce((s, y) => s + y.bytes, 0) / 1024 / 1024).toFixed(1);
console.log(`\n✓ 已写入 ${yearIndex.length} 个年份文件，${features.length} 条轨迹，${totalPoints} 个点，${mb} MB`);
console.log(`✓ 总里程 ${manifest.stats.distanceKm} km，${manifest.stats.firstDate} → ${manifest.stats.lastDate}`);
console.log(`✓ 跳过：无 GPS ${skipped.noGps}，解析失败 ${skipped.parseFailed}，下载失败 ${skipped.failed}，过短 ${skipped.tooShort}`);

if (user.totalMeters > 0) {
  const fetchedMeters = totalKm * 1000 + mergedMeters;
  const diff = Math.abs(fetchedMeters - user.totalMeters) / user.totalMeters;
  if (diff <= 0.02) {
    console.log(`✓ 与行者账号总里程一致（${(user.totalMeters / 1000).toFixed(1)} km，误差 ${(diff * 100).toFixed(2)}%）`);
  } else {
    console.log(
      `⚠ 抓取总里程 ${(fetchedMeters / 1000).toFixed(1)} km 与账号总里程 ${(user.totalMeters / 1000).toFixed(1)} km 不一致（${(diff * 100).toFixed(1)}%）。`,
    );
    console.log('  可能有未抓到的月份或未上传 GPS 的记录，请检查上方月份错误。');
  }
}

console.log(`✓ 用时 ${secs}s，数据目录：${DATA_DIR}`);

function monthListEnd() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
