#!/usr/bin/env node
/**
 * Opens a real Edge/Chrome window on the 行者 login page and waits until the
 * user has logged in. The session cookies are then saved to .cache/cookie.txt.
 *
 * Usage: npm run login
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.cache');
const PROFILE = path.join(CACHE, 'browser-profile');
const COOKIE_FILE = path.join(CACHE, 'cookie.txt');
const USER_FILE = path.join(CACHE, 'user.json');
const PORT = Number(process.env.DEBUG_PORT) || 9333;
const LOGIN_URL = 'https://www.imxingzhe.com/login';
const TIMEOUT_MS = 10 * 60 * 1000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const candidates = [
    process.env.EDGE_PATH,
    process.env.CHROME_PATH,
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('未找到 Edge/Chrome。请设置环境变量 EDGE_PATH 指向浏览器 exe。');
}

async function cdpJson(pathname, timeout = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
        else resolve(msg.result);
      }
    });
    return this;
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function verifyCookie(cookie) {
  const res = await fetch('https://www.imxingzhe.com/api/v4/account/get_user_info/', {
    headers: { Cookie: cookie, 'User-Agent': UA, Referer: 'https://www.imxingzhe.com/' },
  });
  if (!res.ok) return { ok: false, status: res.status };
  const json = await res.json().catch(() => null);
  const info = json && json.data && json.data.userid ? json.data : json;
  if (!info || !(info.userid || info.id)) return { ok: false, status: res.status, json };
  return { ok: true, user: info };
}

async function main() {
  await fsp.mkdir(PROFILE, { recursive: true });

  if (fs.existsSync(COOKIE_FILE)) {
    const existing = (await fsp.readFile(COOKIE_FILE, 'utf8')).trim();
    if (existing) {
      const check = await verifyCookie(existing).catch(() => ({ ok: false }));
      if (check.ok) {
        console.log(`✓ 已有有效登录态：${check.user.username || '(未知)'} (uid=${check.user.userid || check.user.id})`);
        console.log(`  Cookie 文件：${COOKIE_FILE}`);
        return;
      }
      console.log('· 已有 Cookie 已失效，重新登录…');
    }
  }

  const browserPath = findBrowser();
  console.log('正在打开行者登录页…');
  console.log('请在浏览器窗口中完成登录（扫码或账号密码），登录成功后窗口会自动关闭。\n');

  const child = spawn(
    browserPath,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--new-window',
      LOGIN_URL,
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();

  const deadline = Date.now() + TIMEOUT_MS;
  let pageWs = null;
  let lastState = '';

  while (Date.now() < deadline) {
    if (!pageWs) {
      const list = await cdpJson('/json/list');
      const page = Array.isArray(list)
        ? list.find((t) => t.type === 'page' && /imxingzhe\.com/i.test(t.url || '')) ||
          list.find((t) => t.type === 'page')
        : null;
      if (page && page.webSocketDebuggerUrl) {
        try {
          const client = await new Cdp(page.webSocketDebuggerUrl).open();
          await client.send('Network.enable');
          pageWs = client;
        } catch {
          pageWs = null;
        }
      }
    }

    if (pageWs) {
      try {
        const { cookies } = await pageWs.send('Network.getCookies', {
          urls: ['https://www.imxingzhe.com/', LOGIN_URL, 'https://www.imxingzhe.com/home/'],
        });
        const relevant = (cookies || []).filter((c) => /(^|\.)imxingzhe\.com$/i.test(c.domain || ''));
        const session = relevant.find((c) => c.name === 'sessionid' && c.value);
        if (session) {
          const cookieHeader = relevant
            .filter((c) => c.value)
            .map((c) => `${c.name}=${c.value}`)
            .join('; ');
          const check = await verifyCookie(cookieHeader);
          if (check.ok) {
            const user = check.user;
            await fsp.writeFile(COOKIE_FILE, cookieHeader + '\n', { mode: 0o600 });
            await fsp.writeFile(
              USER_FILE,
              JSON.stringify({ id: user.userid || user.id, name: user.username || '', savedAt: new Date().toISOString() }, null, 2),
              'utf8',
            );
            console.log(`✓ 登录成功：${user.username || '(未知)'} (uid=${user.userid || user.id})`);
            console.log(`  Cookie 已保存到 ${COOKIE_FILE}`);
            if (String(user.username || '').toLowerCase() !== 'l1tton') {
              console.log(`⚠ 当前账号不是 L1tton，抓取脚本会拒绝运行。`);
              console.log('  如需抓取 L1tton，请在浏览器中退出后重新登录 L1tton。');
              console.log('  本次窗口保持打开，方便你切换账号；完成后按 Ctrl+C 结束。');
              pageWs.close();
              return;
            }
            await closeBrowser();
            pageWs.close();
            return;
          }
          lastState = `已检测到 sessionid，但校验失败（HTTP ${check.status}），继续等待…`;
        }
      } catch {
        /* page may be navigating; retry */
      }
    }

    if (lastState) {
      console.log(lastState);
      lastState = '';
    }
    await sleep(1500);
  }

  console.log('\n✗ 等待登录超时（10 分钟）。');
  console.log('  可以重新运行 npm run login，或手动把浏览器 Cookie 保存到：');
  console.log(`  ${COOKIE_FILE}`);
  pageWs?.close();
  try {
    await closeBrowser();
  } catch {
    /* ignore */
  }
}

async function closeBrowser() {
  const version = await cdpJson('/json/version');
  if (version && version.webSocketDebuggerUrl) {
    const client = await new Cdp(version.webSocketDebuggerUrl).open();
    await client.send('Browser.close').catch(() => {});
    client.close();
  }
}

main().catch((err) => {
  console.error('✗ 登录助手失败：', err.message);
  process.exitCode = 1;
});
