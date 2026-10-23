// Minimal Chrome DevTools Protocol client (no npm dependencies; uses Node's built-in WebSocket).
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function findChrome(preferred) {
  const candidates = [
    preferred,
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium', '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch {} }
  throw new Error('找不到 Chrome/Edge 浏览器，请在 config.json 的 render.chromePath 填写路径');
}

export async function launchBrowser({chromePath, width = 1920, height = 1080} = {}) {
  const exe = findChrome(chromePath);
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidaily-chrome-'));
  const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--allow-file-access-from-files', '--force-color-profile=srgb', '--font-render-hinting=none',
    `--window-size=${width},${height}`, '--remote-debugging-port=0', `--user-data-dir=${userDir}`, 'about:blank'];
  if (process.platform === 'linux') args.unshift('--no-sandbox');
  const proc = spawn(exe, args, {stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome 启动超时: ' + buf.slice(-500))), 30000);
    proc.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    proc.on('exit', code => { clearTimeout(timer); reject(new Error('Chrome 退出 code=' + code + ' ' + buf.slice(-500))); });
  });
  const conn = await connect(wsUrl);
  const close = async () => {
    try { await conn.send('Browser.close'); } catch {}
    try { conn.ws.close(); } catch {}
    setTimeout(() => { try { proc.kill(); } catch {} try { fs.rmSync(userDir, {recursive: true, force: true}); } catch {} }, 500);
  };
  return {conn, proc, close};
}

async function connect(url) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = e => rej(new Error('CDP 连接失败')); });
  let id = 0; const pending = new Map(); const listeners = [];
  ws.onmessage = ev => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
    if (msg.id && pending.has(msg.id)) {
      const {resolve, reject} = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message + (msg.error.data ? ': ' + msg.error.data : ''))); else resolve(msg.result);
    } else if (msg.method) { for (const l of listeners) l(msg); }
  };
  ws.onclose = () => { for (const {reject} of pending.values()) reject(new Error('CDP 连接已关闭')); pending.clear(); };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const msgId = ++id; pending.set(msgId, {resolve, reject});
    ws.send(JSON.stringify({id: msgId, method, params, ...(sessionId ? {sessionId} : {})}));
  });
  return {ws, send, on: fn => listeners.push(fn), off: fn => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }};
}

export async function openPage(browser, {width = 1920, height = 1080} = {}) {
  const {conn} = browser;
  const {targetId} = await conn.send('Target.createTarget', {url: 'about:blank'});
  const {sessionId} = await conn.send('Target.attachToTarget', {targetId, flatten: true});
  const send = (m, p) => conn.send(m, p, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false});
  const page = {
    send,
    async goto(url, {timeoutMs = 45000, waitUntil = 'load'} = {}) {
      const done = new Promise((resolve) => {
        const ev = waitUntil === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired';
        const fn = msg => { if (msg.sessionId === sessionId && msg.method === ev) { conn.off(fn); resolve(); } };
        conn.on(fn);
      });
      await send('Page.navigate', {url});
      await Promise.race([done, new Promise(r => setTimeout(r, timeoutMs))]);
    },
    async eval(expression, {awaitPromise = true} = {}) {
      const r = await send('Runtime.evaluate', {expression, awaitPromise, returnByValue: true});
      if (r.exceptionDetails) throw new Error('页面脚本错误: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result?.value;
    },
    async screenshot({format = 'jpeg', quality = 92, clip} = {}) {
      const r = await send('Page.captureScreenshot', {format, ...(format === 'jpeg' ? {quality} : {}), ...(clip ? {clip: {...clip, scale: 1}} : {}), optimizeForSpeed: true, captureBeyondViewport: false});
      return Buffer.from(r.data, 'base64');
    },
    async close() { try { await conn.send('Target.closeTarget', {targetId}); } catch {} },
  };
  return page;
}
