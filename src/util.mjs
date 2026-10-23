import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let logFile = null;
export function setLogFile(p) { logFile = p; }
export function log(...args) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', {hour12: false})}] ` + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  console.log(line);
  if (logFile) { try { fs.appendFileSync(logFile, line + '\n'); } catch {} }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function readJson(p, fallback) { try { return JSON.parse((await fsp.readFile(p, 'utf8')).replace(/^﻿/, '')); } catch (e) { if (fallback !== undefined) return fallback; throw e; } }
export async function writeJson(p, v) { await fsp.mkdir(path.dirname(p), {recursive: true}); await fsp.writeFile(p, JSON.stringify(v, null, 2) + '\n', 'utf8'); }
export function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

export function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^﻿/, ''));
  const local = path.join(ROOT, 'config.local.json');
  if (exists(local)) deepMerge(cfg, JSON.parse(fs.readFileSync(local, 'utf8').replace(/^﻿/, '')));
  return cfg;
}
function deepMerge(a, b) { for (const k of Object.keys(b)) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') deepMerge(a[k], b[k]); else a[k] = b[k]; } return a; }

/** Run a command; resolves {code, out, err}. */
export function run(cmd, args, {cwd, input, timeoutMs = 10 * 60 * 1000, shell = false, env, onLine} = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, {cwd, shell, windowsHide: true, env: env ? {...process.env, ...env} : process.env, stdio: ['pipe', 'pipe', 'pipe']}); }
    catch (e) { resolve({code: null, out: '', err: String(e), error: e.code || 'SPAWN'}); return; }
    let out = '', err = '', killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', d => { out += d; if (onLine) String(d).split(/\r?\n/).filter(Boolean).forEach(onLine); });
    child.stderr.on('data', d => { err += d; });
    child.stdin.on('error', () => {});
    child.on('error', e => { clearTimeout(timer); resolve({code: null, out, err: err + String(e), error: e.code || 'SPAWN'}); });
    child.on('close', code => { clearTimeout(timer); resolve({code, out, err, killed}); });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

export function findFfmpeg(cfg = {}) {
  const c = [cfg.render?.ffmpegPath,
    path.join(ROOT, 'tools', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    path.join(ROOT, 'tools', 'ffmpeg.exe'), '/usr/bin/ffmpeg'].filter(Boolean);
  for (const p of c) if (exists(p)) return {ffmpeg: p, ffprobe: p.replace(/ffmpeg(\.exe)?$/i, m => m.replace('ffmpeg', 'ffprobe'))};
  return {ffmpeg: 'ffmpeg', ffprobe: 'ffprobe'};
}

export async function ffprobeDuration(ffprobe, file) {
  const r = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const d = parseFloat(r.out); if (!Number.isFinite(d)) throw new Error('无法读取时长: ' + file + ' ' + r.err.slice(-300)); return d;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
export async function fetchText(url, {timeoutMs = 20000, headers = {}, maxBytes = 6 * 1024 * 1024, retries = 1} = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers: {'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers}});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error('响应过大');
      const ct = res.headers.get('content-type') || '';
      let charset = (ct.match(/charset=([\w-]+)/i) || [])[1];
      if (!charset) { const head = buf.subarray(0, 2048).toString('latin1'); charset = (head.match(/charset=["']?([\w-]+)/i) || [])[1]; }
      let text;
      try { text = new TextDecoder((charset || 'utf-8').toLowerCase()).decode(buf); } catch { text = buf.toString('utf8'); }
      return {text, url: res.url, contentType: ct};
    } catch (e) { lastErr = e; if (attempt < retries) await sleep(800); }
  }
  throw lastErr;
}
export async function fetchJson(url, opts = {}) { const r = await fetchText(url, {...opts, headers: {accept: 'application/json', ...(opts.headers || {})}}); return JSON.parse(r.text); }
export async function fetchBuffer(url, {timeoutMs = 20000, maxBytes = 12 * 1024 * 1024, headers = {}} = {}) {
  const res = await fetch(url, {signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers: {'user-agent': UA, ...headers}});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer()); if (buf.length > maxBytes) throw new Error('文件过大');
  return {buf, contentType: res.headers.get('content-type') || '', url: res.url};
}

export function dateParts(d = new Date(), tz = 'Asia/Shanghai') {
  const f = new Intl.DateTimeFormat('en-CA', {timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hourCycle: 'h23'});
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  const wk = {Sun: '日', Mon: '一', Tue: '二', Wed: '三', Thu: '四', Fri: '五', Sat: '六'}[p.weekday];
  // hour 是北京时间的小时（电脑时区可能是美国太平洋时间，别用 new Date().getHours()）
  return {iso: `${p.year}-${p.month}-${p.day}`, y: +p.year, m: +p.month, d: +p.day, weekday: wk, hour: +p.hour};
}

export function mmss(sec) { sec = Math.max(0, Math.floor(sec)); return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; }
