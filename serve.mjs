#!/usr/bin/env node
/**
 * Public server for the route atlas.
 * - Serves ./web
 * - POST /api/sync  (行者 cookie -> own tracks, streamed as NDJSON)
 *
 * No database. Cookies and track data only live inside the request.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  syncOwnData,
  AuthError,
  NoTracksError,
  RateLimitError,
  UpstreamError,
} from './scripts/lib/xingzhe-sync.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Optional local .env (KEY=VALUE). Real environment variables win.
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const index = trimmed.indexOf('=');
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = value;
    }
  }
} catch (err) {
  console.warn(`.env load skipped: ${err.message}`);
}

const ROOT = path.join(__dirname, 'web');
const START_PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';
const IS_PROD = process.env.NODE_ENV === 'production' || process.env.HTTPS === '1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_SYNC_TRACKS = Math.max(1, Number(process.env.MAX_SYNC_TRACKS) || 1500);
const GLOBAL_SYNC_LIMIT = Math.max(1, Number(process.env.GLOBAL_SYNC_LIMIT) || 3);
const TIANDITU_KEY = String(process.env.TIANDITU_KEY || '').trim();
const SYNC_COOLDOWN_MS = 5 * 60 * 1000;
const BODY_LIMIT = 16 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob: https://*.autonavi.com",
  "connect-src 'self' https://*.autonavi.com https://tiles.openfreemap.org",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const baseHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const activeByIp = new Map();
let activeSyncs = 0;

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function sendJson(res, status, payload, extra = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...baseHeaders,
    ...extra,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendStatic(res, status, body, headers = {}) {
  res.writeHead(status, { ...baseHeaders, ...headers });
  res.end(body);
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      const error = new Error('请求体过大');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('请求格式不正确');
    error.status = 400;
    throw error;
  }
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed && origin === allowed) return true;
  try {
    const expectedHost =
      TRUST_PROXY && req.headers['x-forwarded-host']
        ? req.headers['x-forwarded-host']
        : req.headers.host;
    return new URL(origin).host === expectedHost;
  } catch {
    return false;
  }
}

async function handleSync(req, res) {
  if (!sameOrigin(req)) {
    sendJson(res, 403, { message: '来源校验失败' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, err.status || 400, { message: err.message });
    return;
  }

  let cookie = typeof body.cookie === 'string' ? body.cookie.trim() : '';
  if (/^cookie\s*:/i.test(cookie)) cookie = cookie.replace(/^cookie\s*:/i, '').trim();
  if (!cookie || cookie.length > 12000 || !cookie.includes('sessionid=')) {
    sendJson(res, 400, { message: '请粘贴包含 sessionid 的完整 Cookie' });
    return;
  }
  cookie = cookie.replace(/[\r\n]/g, ' ');
  const range = body.range === '3y' || body.range === 'all' ? body.range : '1y';

  const ip = clientIp(req);
  const now = Date.now();
  const record = activeByIp.get(ip);
  if (activeSyncs >= GLOBAL_SYNC_LIMIT) {
    sendJson(res, 429, { message: '当前同步人数较多，请稍后再试' }, { 'Retry-After': '60' });
    return;
  }
  if (record && (record.active || now - record.startedAt < SYNC_COOLDOWN_MS)) {
    sendJson(res, 429, { message: '同步过于频繁，请 5 分钟后再试' }, { 'Retry-After': '300' });
    return;
  }

  activeByIp.set(ip, { startedAt: now, active: true });
  activeSyncs++;
  const started = Date.now();
  const controller = new AbortController();
  let closed = false;

  res.on('close', () => {
    if (!res.writableEnded) {
      closed = true;
      controller.abort();
    }
  });

  res.writeHead(200, {
    ...baseHeaders,
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no',
    ...(IS_PROD ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  });
  res.flushHeaders?.();

  const write = (payload) => {
    if (closed || res.writableEnded) return;
    try {
      res.write(JSON.stringify(payload) + '\n');
    } catch {
      closed = true;
      controller.abort();
    }
  };

  try {
    const result = await syncOwnData({
      cookie,
      signal: controller.signal,
      maxTracks: MAX_SYNC_TRACKS,
      range,
      onEvent: write,
    });
    write({
      type: 'done',
      user: result.user,
      manifest: result.manifest,
      features: result.features,
    });
    console.log(
      `sync ok ip=${ip} range=${range} tracks=${result.features.length} mergedSkipped=${
        result.manifest.skipped.merged
      } monthsSkipped=${result.manifest.skipped.monthErrors} ms=${Date.now() - started}`,
    );
  } catch (err) {
    if (closed || err.name === 'AbortError') {
      console.log(`sync aborted ip=${ip} ms=${Date.now() - started}`);
    } else if (err instanceof RateLimitError) {
      // Keep the short local cooldown: retrying immediately makes the 行者
      // rate limit worse.
      write({ type: 'error', code: 'rate_limited', message: err.message });
      console.log(`sync rate-limited ip=${ip} ms=${Date.now() - started}`);
    } else if (err instanceof AuthError) {
      activeByIp.delete(ip);
      write({ type: 'error', code: 'auth', message: err.message });
      console.log(`sync auth-failed ip=${ip} ms=${Date.now() - started}`);
    } else if (err instanceof NoTracksError) {
      activeByIp.delete(ip);
      write({ type: 'error', code: 'no_tracks', message: err.message });
      console.log(`sync empty ip=${ip} ms=${Date.now() - started}`);
    } else if (err instanceof UpstreamError) {
      activeByIp.delete(ip);
      write({ type: 'error', code: 'upstream', message: err.message });
      console.log(`sync upstream-failed ip=${ip} ms=${Date.now() - started}`);
    } else {
      console.error(`sync failed ip=${ip} ms=${Date.now() - started} error=${err.message}`);
      write({ type: 'error', code: 'error', message: '同步失败，请稍后重试' });
    }
  } finally {
    activeSyncs = Math.max(0, activeSyncs - 1);
    const current = activeByIp.get(ip);
    if (current) {
      current.active = false;
      current.finishedAt = Date.now();
    }
    if (!res.writableEnded) res.end();
  }
}

async function handleTiandituTile(req, res, pathname) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { message: 'Method Not Allowed' }, { Allow: 'GET' });
    return;
  }
  const match = pathname.match(/^\/api\/tdt\/(vec_w|cva_w|ter_w|cta_w)\/(\d{1,2})\/(\d+)\/(\d+)$/);
  if (!match) {
    sendJson(res, 404, { message: '瓦片地址不正确' });
    return;
  }
  if (!TIANDITU_KEY) {
    sendJson(res, 503, { message: '天地图未配置' });
    return;
  }

  const layer = match[1];
  const layerName = { vec_w: 'vec', cva_w: 'cva', ter_w: 'ter', cta_w: 'cta' }[layer];
  const z = Number(match[2]);
  const y = Number(match[3]);
  const x = Number(match[4]);
  const maxZoom = layer === 'ter_w' || layer === 'cta_w' ? 14 : 18;
  const limit = 2 ** z;
  if (z < 1 || z > maxZoom || x < 0 || y < 0 || x >= limit || y >= limit) {
    sendJson(res, 400, { message: '瓦片坐标超出范围' });
    return;
  }

  const subdomain = (z + x + y) % 8;
  const upstreamUrl =
    `https://t${subdomain}.tianditu.gov.cn/${layer}/wmts` +
    '?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
    `&LAYER=${layerName}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles` +
    `&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}` +
    `&tk=${encodeURIComponent(TIANDITU_KEY)}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: {
        Accept: 'image/*',
        'User-Agent': 'route-atlas/1.0',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!upstream.ok) {
      console.warn(`tdt tile failed layer=${layer} z=${z} x=${x} y=${y} status=${upstream.status}`);
      sendJson(res, 502, { message: '天地图瓦片加载失败' });
      return;
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      ...baseHeaders,
      'Content-Type': upstream.headers.get('content-type') || 'image/png',
      'Content-Length': buffer.length,
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(buffer);
  } catch (err) {
    console.warn(`tdt tile error layer=${layer} z=${z} x=${x} y=${y} error=${err.message}`);
    if (!res.headersSent) sendJson(res, 502, { message: '天地图瓦片加载失败' });
    else if (!res.writableEnded) res.end();
  }
}

function serveFile(req, res, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendStatic(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    return;
  }
  let filePath;
  try {
    const decoded = decodeURIComponent(urlPath);
    if (decoded.includes('\0') || decoded.split('/').some((part) => part === '..' || part.startsWith('.'))) {
      sendStatic(res, 400, 'Bad Request');
      return;
    }
    filePath = path.resolve(ROOT, '.' + (decoded === '/' ? '/index.html' : decoded));
  } catch {
    sendStatic(res, 400, 'Bad Request');
    return;
  }
  if (!filePath.startsWith(ROOT + path.sep)) {
    sendStatic(res, 403, 'Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendStatic(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const isVendor = filePath.includes(`${path.sep}vendor${path.sep}`);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': isVendor
        ? 'public, max-age=86400'
        : ext === '.html' || ext === '.js' || ext === '.css' || ext === '.json'
          ? 'no-cache'
          : 'public, max-age=86400',
    };
    if (ext === '.html') headers['Content-Security-Policy'] = CSP;
    if (IS_PROD) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...baseHeaders, ...headers });
      res.end();
      return;
    }
    res.writeHead(200, { ...baseHeaders, ...headers });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    sendJson(res, 400, { message: '请求地址不正确' });
    return;
  }

  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true, tianditu: Boolean(TIANDITU_KEY) });
    return;
  }
  if (pathname === '/api/config') {
    sendJson(res, 200, { tianditu: Boolean(TIANDITU_KEY) });
    return;
  }
  if (pathname.startsWith('/api/tdt/')) {
    handleTiandituTile(req, res, pathname).catch((err) => {
      console.error('tdt handler error', err.message);
      if (!res.headersSent) sendJson(res, 500, { message: '瓦片服务异常' });
      else if (!res.writableEnded) res.end();
    });
    return;
  }
  if (pathname === '/api/sync') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' }, { Allow: 'POST' });
      return;
    }
    handleSync(req, res).catch((err) => {
      console.error('sync handler error', err.message);
      if (!res.headersSent) sendJson(res, 500, { message: '同步服务异常' });
      else if (!res.writableEnded) res.end();
    });
    return;
  }
  serveFile(req, res, pathname);
});

server.requestTimeout = 15 * 60 * 1000;
server.headersTimeout = 30 * 1000;

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [ip, record] of activeByIp) {
    if (!record.active && record.finishedAt && record.finishedAt < cutoff) activeByIp.delete(ip);
  }
}, 10 * 60 * 1000).unref();

function listen(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && !process.env.PORT && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error(err.message);
      process.exitCode = 1;
    }
  });
  server.listen(port, HOST, () => {
    console.log(`Route atlas: http://${HOST}:${port}/`);
    console.log(`Sync endpoint: POST /api/sync (max ${MAX_SYNC_TRACKS} tracks per sync)`);
  });
}

listen(START_PORT, 10);
