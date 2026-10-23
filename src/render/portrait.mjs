// 竖屏 1080×1920 渲染（template-portrait.html）：把横屏的 timeline.json 加上主持人、大数字、点评等字段，逐帧截图合成。
// Sample render: node src/render/portrait.mjs --run runs/<date>-news [--extra extra.json] [--to seconds]
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {launchBrowser, openPage} from './cdp.mjs';
import {brandsIn, logoData} from './logos.mjs';
import {muxAudio} from './render.mjs';
import {ROOT, readJson, writeJson, loadConfig, findFfmpeg, log} from '../util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = 1080, H = 1920;
// On-screen host images: config.host.dir (relative to the repo root), default the neutral placeholder. See docs/custom-host.md.
export const HOST = (() => { let h = {}; try { h = loadConfig().host || {}; } catch {} return {name: h.name || 'Host', dir: path.resolve(ROOT, h.dir || 'assets/host/placeholder')}; })();

/** 每 1/fps 秒一个嘴型等级（0 闭嘴、1 半张、2 张开），只在有字幕的时候张嘴。 */
export async function mouthTrack({ffmpeg, audio, cues, duration, fps = 15}) {
  const rate = 8000;
  const pcm = await new Promise((res, rej) => {
    const p = spawn(ffmpeg, ['-v', 'error', '-i', audio, '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    const chunks = []; p.stdout.on('data', d => chunks.push(d)); p.on('close', c => c === 0 ? res(Buffer.concat(chunks)) : rej(new Error('读取配音失败')));
  });
  const n = Math.ceil(duration * fps), win = Math.round(rate / fps); const rms = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0, c = 0;
    for (let j = k * win; j < (k + 1) * win && j * 2 + 1 < pcm.length; j++) { const v = pcm.readInt16LE(j * 2) / 32768; s += v * v; c++; }
    rms[k] = c ? Math.sqrt(s / c) : 0;
  }
  const sorted = [...rms].filter(v => v > .005).sort((a, b) => a - b);
  const q = p => sorted[Math.floor(sorted.length * p)] || 1;
  const lo = q(.25), hi = q(.7);
  const talking = t => cues.some(c => t >= c.t0 - .05 && t < c.t1 + .05);
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = k / fps;
    out.push(!talking(t) || rms[k] < lo ? 0 : rms[k] < hi ? 1 : 2);
  }
  // 去掉只有一格的跳动，看起来不那么抖
  for (let k = 1; k < n - 1; k++) if (out[k - 1] === out[k + 1] && out[k] !== out[k - 1] && out[k] === 0) out[k] = out[k - 1];
  return out;
}

const dataUri = f => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;

/** 横屏时间轴 → 竖屏模板要的数据。extra：{<新闻id>: {ribbon, ribbonSub, hero, chips, comment, emote, pose}, intro: {...}, outro: {...}}。 */
export function portraitData(timeline, {extra = {}, mouth, mouthFps}) {
  const host = {name: HOST.name, avatar: dataUri(path.join(HOST.dir, 'avatar.png')), images: {}};
  for (const f of fs.readdirSync(HOST.dir)) { const m = f.match(/^([a-z]+-[0-9b])\.png$/); if (m) host.images[m[1]] = dataUri(path.join(HOST.dir, f)); }
  let no = 0;
  const items = timeline.segments.filter(s => s.type === 'item');
  const segments = timeline.segments.map(s => {
    const x = extra[s.id] || {};
    if (s.type === 'item') {
      const brand = brandsIn(`${x.ribbon || ''} ${s.title}`)[0];
      return {...s, no: ++no, extra: x, tab: x.tab || (brand ? brand[0].toUpperCase() + brand.slice(1) : s.short), ribbon: x.ribbon, ribbonSub: x.ribbonSub, logo: brand ? logoData(brand) : null, comment: x.comment || '', emote: x.emote || '', pose: x.pose || 'idle'};
    }
    if (s.type === 'intro') {
      const list = items.map(it => { const b = brandsIn(it.title)[0]; return {title: (extra[it.id] || {}).ribbon || it.title, logo: b ? logoData(b) : null}; });
      return {...s, list, ovHead: x.ovHead || '今日要闻', comment: x.comment || '', emote: x.emote || '', pose: x.pose || 'idle'};
    }
    return {...s, comment: x.comment || '', emote: x.emote || '', pose: x.pose || 'idle'};
  });
  return {...timeline, width: W, height: H, host, itemCount: items.length, segments, mouth, mouthFps};
}

async function preparePage(runDir) {
  const pageDir = path.join(runDir, '_page');
  await fsp.mkdir(pageDir, {recursive: true});
  for (const f of ['template-portrait.html', 'icons.js']) await fsp.copyFile(path.join(HERE, f), path.join(pageDir, f));
  return pathToFileURL(path.join(pageDir, 'template-portrait.html')).href;
}

function encoder(ffmpeg, outFile, fps, crf = 20) {
  const p = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(fps), '-movflags', '+faststart', outFile], {stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true});
  let err = ''; p.stderr.on('data', d => { err += d; });
  const done = new Promise((res, rej) => p.on('close', c => c === 0 ? res() : rej(new Error('ffmpeg 编码失败: ' + err.slice(-800)))));
  const write = buf => new Promise(res => { if (!p.stdin.write(buf)) p.stdin.once('drain', res); else res(); });
  return {write, end: () => { p.stdin.end(); return done; }};
}

async function workerPage(url, data, chromePath) {
  const browser = await launchBrowser({chromePath, width: W, height: H});
  const page = await openPage(browser, {width: W, height: H});
  await page.goto(url);
  const init = await page.eval(`window.__init(${JSON.stringify(data)})`);
  return {browser, page, init};
}

/** 竖屏视频（无声），N 个 Chrome 并行，画面不变的帧复用截图。 */
export async function renderPortrait(data, {runDir, outFile, ffmpeg, chromePath, workers = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))), crf = 20, toSec} = {}) {
  const fps = data.fps; const url = await preparePage(runDir);
  const total = Math.round((toSec ?? data.duration) * fps);
  const n = Math.max(1, Math.min(workers, Math.ceil(total / 300))); const per = Math.ceil(total / n);
  const chunkDir = path.join(runDir, '_chunks-portrait'); await fsp.mkdir(chunkDir, {recursive: true});
  let captured = 0; const started = Date.now();
  const files = await Promise.all([...Array(n).keys()].map(async w => {
    const a = w * per, b = Math.min(total, a + per); const file = path.join(chunkDir, `chunk-${String(w).padStart(2, '0')}.mp4`);
    const {browser, page, init} = await workerPage(url, data, chromePath);
    if (w === 0) log('竖屏渲染页面就绪', init);
    const enc = encoder(ffmpeg, file, fps, crf); let lastSig = null, lastBuf = null;
    try {
      for (let f = a; f < b; f++) {
        const sig = await page.eval(`window.renderAt(${f / fps})`, {awaitPromise: false});
        if (sig !== lastSig || !lastBuf) { lastBuf = await page.screenshot({quality: 90}); lastSig = sig; captured++; }
        await enc.write(lastBuf);
      }
    } finally { await enc.end(); await browser.close(); }
    return file;
  }));
  const list = path.join(chunkDir, 'list.txt');
  await fsp.writeFile(list, files.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
  await new Promise((res, rej) => { const p = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', outFile], {windowsHide: true}); p.on('close', c => c === 0 ? res() : rej(new Error('片段合并失败'))); });
  await fsp.rm(chunkDir, {recursive: true, force: true});
  return {frames: total, captured, seconds: (Date.now() - started) / 1000};
}

/**
 * 换条音效：用 ffmpeg 现场合成一声短促的「咔哒」（两个衰减很快的正弦波叠加），不用任何外部音效素材，没有版权问题。
 * 每条新闻开头（蓝色色块扫过时）响一声，叠到配音上。
 */
export async function addClicks({ffmpeg, audio, times, outFile, volume = .55}) {
  if (!times.length) { await fsp.copyFile(audio, outFile); return outFile; }
  const click = `aevalsrc='${volume}*(0.75*sin(2*PI*2300*t)*exp(-170*t)+0.5*sin(2*PI*1100*t)*exp(-90*t))':s=48000:d=0.09`;
  const ins = ['-i', audio]; const parts = []; const labels = [];
  times.forEach((t, k) => { ins.push('-f', 'lavfi', '-i', click); const ms = Math.max(0, Math.round(t * 1000)); parts.push(`[${k + 1}:a]aformat=channel_layouts=stereo,adelay=${ms}|${ms}[c${k}]`); labels.push(`[c${k}]`); });
  const filter = `${parts.join(';')};[0:a]aformat=sample_rates=48000:channel_layouts=stereo[v];[v]${labels.join('')}amix=inputs=${times.length + 1}:normalize=0:duration=first[out]`;
  await new Promise((res, rej) => {
    const p = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...ins, '-filter_complex', filter, '-map', '[out]', '-c:a', 'pcm_s16le', outFile], {stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
    let err = ''; p.stderr.on('data', d => { err += d; }); p.on('close', c => c === 0 ? res() : rej(new Error('音效混音失败: ' + err.slice(-500))));
  });
  return outFile;
}

/** 截几张静帧看效果。 */
export async function portraitStills(data, times, {runDir, outDir, chromePath}) {
  const url = await preparePage(runDir); await fsp.mkdir(outDir, {recursive: true});
  const {browser, page} = await workerPage(url, data, chromePath); const out = [];
  try {
    for (const t of times) {
      await page.eval(`window.renderAt(${t})`, {awaitPromise: false});
      const p = path.join(outDir, `竖屏-${t.toFixed(1)}s.png`); await fsp.writeFile(p, await page.screenshot({format: 'png'})); out.push(p);
    }
  } finally { await browser.close(); }
  return out;
}

// 命令行：出样片
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const runDir = path.resolve(ROOT, arg('--run') || 'runs/sample');
  const cfg = loadConfig(); const {ffmpeg} = findFfmpeg(cfg);
  const timeline = await readJson(path.join(runDir, 'timeline.json'));
  const extra = await readJson(path.resolve(ROOT, arg('--extra') || path.join(runDir, 'portrait-extra.json')), {});
  const mouthFps = 15;
  const cues = timeline.segments.flatMap(s => s.cues || []);
  const mouth = await mouthTrack({ffmpeg, audio: path.join(runDir, 'narration.wav'), cues, duration: timeline.duration, fps: mouthFps});
  const data = portraitData(timeline, {extra, mouth, mouthFps});
  await writeJson(path.join(runDir, 'timeline-portrait.json'), {...data, host: {...data.host, avatar: '(略)', images: Object.keys(data.host.images)}});
  const stills = arg('--stills');
  if (stills) {
    const out = await portraitStills(data, stills.split(',').map(Number), {runDir, outDir: path.join(runDir, '竖屏样片截图'), chromePath: cfg.render?.chromePath});
    log('静帧：', out.join('\n'));
  } else {
    const toSec = arg('--to') ? Number(arg('--to')) : undefined;
    const silent = path.join(runDir, '_portrait-silent.mp4');
    const r = await renderPortrait(data, {runDir, outFile: silent, ffmpeg, chromePath: cfg.render?.chromePath, workers: cfg.render?.workers, toSec});
    log(`竖屏渲染完成：${r.frames} 帧，实际截图 ${r.captured} 张，用时 ${r.seconds.toFixed(0)} 秒`);
    const final = path.join(runDir, `${timeline.date}-竖屏样片.mp4`);
    const mixed = path.join(runDir, '_portrait-audio.wav');
    await addClicks({ffmpeg, audio: path.join(runDir, 'narration.wav'), times: data.segments.filter(s => s.type === 'item').map(s => s.start), outFile: mixed});
    await muxAudio({ffmpeg, video: silent, audio: mixed, outFile: final});
    await fsp.rm(silent, {force: true}); await fsp.rm(mixed, {force: true});
    log('样片：', final);
  }
}
