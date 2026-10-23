// Frame-accurate renderer: HTML template driven by renderAt(t) → JPEG frames → ffmpeg (x264).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {launchBrowser, openPage} from './cdp.mjs';
import {log, run} from '../util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function preparePage(runDir, name = 'template.html') {
  const pageDir = path.join(runDir, '_page');
  await fsp.mkdir(pageDir, {recursive: true});
  for (const f of [name, 'icons.js']) await fsp.copyFile(path.join(HERE, f), path.join(pageDir, f));
  return pathToFileURL(path.join(pageDir, name)).href;
}

async function startWorkerPage(url, timeline, chromePath) {
  const browser = await launchBrowser({chromePath});
  const page = await openPage(browser);
  await page.goto(url);
  const init = await page.eval(`window.__init(${JSON.stringify(timeline)})`);
  return {browser, page, init};
}

function encoder(ffmpeg, outFile, fps, {crf = 20, preset = 'veryfast'} = {}) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(fps), '-movflags', '+faststart', outFile];
  const p = spawn(ffmpeg, args, {stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true});
  let err = ''; p.stderr.on('data', d => { err += d; });
  const done = new Promise((res, rej) => p.on('close', c => c === 0 ? res() : rej(new Error('ffmpeg 编码失败: ' + err.slice(-800)))));
  const write = buf => new Promise((res, rej) => { if (!p.stdin.write(buf)) p.stdin.once('drain', res); else res(); });
  return {write, end: () => { p.stdin.end(); return done; }};
}

/** Render the whole timeline into an mp4 (video only) using N parallel Chrome workers. */
export async function renderVideo(timeline, {runDir, outFile, ffmpeg = 'ffmpeg', chromePath, workers = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))), crf = 20, fromSec = 0, toSec, onProgress} = {}) {
  const fps = timeline.fps;
  const url = await preparePage(runDir);
  const first = Math.round(fromSec * fps);
  const last = Math.round((toSec ?? timeline.duration) * fps); // exclusive
  const total = last - first;
  const n = Math.max(1, Math.min(workers, Math.ceil(total / 300)));
  const per = Math.ceil(total / n);
  const chunkDir = path.join(runDir, '_chunks'); await fsp.mkdir(chunkDir, {recursive: true});
  let doneFrames = 0, captured = 0; const started = Date.now();
  const tick = () => { onProgress?.({done: doneFrames, total, captured, elapsed: (Date.now() - started) / 1000}); };
  const progressTimer = setInterval(tick, 5000);
  const jobs = [];
  for (let w = 0; w < n; w++) {
    const a = first + w * per, b = Math.min(last, a + per); if (a >= b) continue;
    const file = path.join(chunkDir, `chunk-${String(w).padStart(2, '0')}.mp4`);
    jobs.push((async () => {
      const {browser, page, init} = await startWorkerPage(url, timeline, chromePath);
      if (w === 0) log('渲染页面就绪', init);
      const enc = encoder(ffmpeg, file, fps, {crf});
      let lastSig = null, lastBuf = null;
      try {
        for (let f = a; f < b; f++) {
          const t = f / fps;
          const sig = await page.eval(`window.renderAt(${t})`, {awaitPromise: false});
          if (sig !== lastSig || !lastBuf) { lastBuf = await page.screenshot({quality: 90}); lastSig = sig; captured++; }
          await enc.write(lastBuf); doneFrames++;
        }
      } finally { await enc.end().catch(e => { throw e; }); await browser.close(); }
      return file;
    })());
  }
  let files;
  try { files = await Promise.all(jobs); } finally { clearInterval(progressTimer); tick(); }
  const list = path.join(chunkDir, 'list.txt');
  await fsp.writeFile(list, files.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  const r = await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', outFile]);
  if (r.code !== 0) throw new Error('视频片段合并失败: ' + r.err.slice(-600));
  await fsp.rm(chunkDir, {recursive: true, force: true});
  return {outFile, frames: total, captured, seconds: (Date.now() - started) / 1000};
}

/** Render still PNG frames at given times (for previews / QA). */
export async function renderStills(timeline, times, {runDir, outDir, chromePath, prefix = 'frame'} = {}) {
  const url = await preparePage(runDir);
  await fsp.mkdir(outDir, {recursive: true});
  const {browser, page} = await startWorkerPage(url, timeline, chromePath);
  const out = [];
  try {
    for (const t of times) {
      await page.eval(`window.renderAt(${t})`, {awaitPromise: false});
      const buf = await page.screenshot({format: 'png'});
      const p = path.join(outDir, `${prefix}-${String(t.toFixed(2)).replace('.', '_')}.png`);
      await fsp.writeFile(p, buf); out.push(p);
    }
  } finally { await browser.close(); }
  return out;
}

/** Render the cover (cover.html) to a PNG/JPG. 竖版封面：page='cover-portrait.html', width=1080, height=1440。 */
export async function renderCover(coverData, {runDir, outFile, chromePath, page: pageName = 'cover.html', width = 1920, height = 1080, onInit}) {
  const url = await preparePage(runDir, pageName);
  const browser = await launchBrowser({chromePath, width, height});
  try {
    const page = await openPage(browser, {width, height});
    await page.goto(url);
    const res = await page.eval(`window.__init(${JSON.stringify(coverData)})`);
    onInit?.(res); // 新封面模板会回报用了哪个样式、有没有字溢出
    const buf = await page.screenshot({format: outFile.endsWith('.png') ? 'png' : 'jpeg', quality: 95});
    await fsp.writeFile(outFile, buf);
  } finally { await browser.close(); }
  return outFile;
}

/** Mux narration audio into the rendered video. */
export async function muxAudio({ffmpeg, video, audio, outFile}) {
  const r = await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', '-movflags', '+faststart', outFile]);
  if (r.code !== 0) throw new Error('音视频合成失败: ' + r.err.slice(-600));
  return outFile;
}
