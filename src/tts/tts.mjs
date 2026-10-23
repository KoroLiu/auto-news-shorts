// Narration: Edge / Qwen3 / GPT-SoVITS / MiniMax TTS per segment → word timings → subtitle cues, card focus, media windows → one mixed audio track.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn as spawnProc} from 'node:child_process';
import {log, run, exists, ffprobeDuration, readJson, writeJson, ROOT, findFfmpeg} from '../util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function findPython(cfg) {
  const cands = [];
  if (cfg.tts?.python) cands.push([cfg.tts.python, []]);
  cands.push(['python', []], ['py', ['-3']], ['python3', []]);
  for (const base of [path.join(process.env.ProgramData || '', 'anaconda3'), path.join(process.env.USERPROFILE || '', 'anaconda3'), path.join(process.env.USERPROFILE || '', 'miniconda3')])
    cands.push([path.join(base, 'python.exe'), []]);
  for (const [exe, pre] of cands) {
    const r = await run(exe, [...pre, '-c', 'import sys;print(sys.version_info[0])'], {timeoutMs: 20000});
    if (r.code === 0 && r.out.trim() === '3') return {exe, pre};
  }
  throw new Error('找不到 Python 3。请安装 Python 或在 config.local.json 里设置 tts.python');
}

// ---------- text helpers ----------
const PUNCT = /[\s，。！？；：、,.!?;:“”"‘’'（）()《》<>【】\[\]「」『』—–\-·…~～\/\\|]/u;
const skeletonChars = s => [...String(s)].filter(c => !PUNCT.test(c)).map(c => c.toLowerCase());
export const unitWidth = s => [...String(s)].reduce((w, c) => w + (/[\x00-\x7F]/.test(c) ? (c === ' ' ? .3 : .55) : 1), 0);

/** Text sent to TTS: light cleanup so numbers/English read naturally. Must keep the same skeleton characters. */
export function ttsText(s) {
  return String(s)
    .replace(/(\p{L})-(\d)/gu, '$1 $2')            // GPT-6 → GPT 6
    .replace(/(\d)-(\p{L})/gu, '$1 $2')
    .replace(/\s*\/\s*/g, '、')
    .replace(/[“”"]/g, '')
    .replace(/\s+/g, ' ').trim();
}

/** Split narration into short subtitle chunks (≤ maxUnits wide), never across sentences. */
export function subtitleChunks(text, maxUnits = 22) {
  const out = [];
  const clauses = String(text).match(/[^，。！？；：,!?;:]+[，。！？；：,!?;:]*/gu) || [String(text)];
  let buf = '';
  const push = s => { s = s.trim(); if (s) out.push(s); };
  for (const cl of clauses) {
    const endsSentence = /[。！？!?]$/.test(cl);
    if (unitWidth(buf + cl) <= maxUnits && buf && unitWidth(buf) < maxUnits * .55) { buf += cl; }
    else { push(buf); buf = cl; }
    if (unitWidth(buf) > maxUnits) { splitLong(buf, maxUnits).forEach(push); buf = ''; }
    if (endsSentence) { push(buf); buf = ''; }
  }
  push(buf);
  return out;
}
function splitLong(s, maxUnits) {
  if (unitWidth(s) <= maxUnits) return [s];
  const seg = new Intl.Segmenter('zh', {granularity: 'word'});
  const toks = [...seg.segment(s)].map(x => x.segment);
  const total = unitWidth(s); const parts = Math.ceil(total / maxUnits); const target = total / parts;
  // choose the best break near `target`, preferring 、 / spaces / word edges
  let best = -1, bestScore = Infinity, acc = '';
  for (let i = 0; i < toks.length - 1; i++) {
    acc += toks[i];
    const w = unitWidth(acc); if (w > maxUnits) break;
    const next = toks[i + 1];
    if (/^[，。！？、,.!?%）)》”]$/.test(next)) continue;          // never start a line with punctuation
    let pen = 1.5;
    if (/[、]$/.test(toks[i])) pen = 0; else if (/\s$/.test(toks[i]) || /^\s/.test(next)) pen = .4;
    else if (/[A-Za-z0-9]$/.test(toks[i]) && /^[A-Za-z0-9]/.test(next)) pen = 9;
    const score = Math.abs(w - target) + pen * 2;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  if (best < 0) return [s];
  const left = toks.slice(0, best + 1).join(''), right = toks.slice(best + 1).join('');
  return [left, ...splitLong(right, maxUnits)];
}
export function displayChunk(s) { return s.replace(/[，。；：、,;:]+$/u, '').replace(/^[，。；：、,;:]+/u, '').trim(); }

/** Map each skeleton char of `text` to a time using Edge word boundaries. */
export function charTimes(text, words, duration) {
  const sk = skeletonChars(text);
  const t0 = new Array(sk.length).fill(null), t1 = new Array(sk.length).fill(null);
  let p = 0;
  for (const w of words.filter(w => w.kind !== 'SentenceBoundary')) {
    const ws = skeletonChars(w.text); if (!ws.length) continue;
    let found = -1;
    for (let q = p; q <= Math.min(sk.length - ws.length, p + 24); q++) {
      let ok = true; for (let k = 0; k < ws.length; k++) if (sk[q + k] !== ws[k]) { ok = false; break; }
      if (ok) { found = q; break; }
    }
    if (found < 0) continue;
    const span = (w.t1 - w.t0) / ws.length;
    for (let k = 0; k < ws.length; k++) { t0[found + k] = w.t0 + span * k; t1[found + k] = w.t0 + span * (k + 1); }
    p = found + ws.length;
  }
  // sentence-boundary fallback / interpolation for unmatched chars
  const known = t0.map((v, i) => v === null ? null : i).filter(v => v !== null);
  const matched = known.length / Math.max(1, sk.length);
  for (let i = 0; i < sk.length; i++) {
    if (t0[i] !== null) continue;
    let a = i - 1; while (a >= 0 && t0[a] === null) a--;
    let b = i + 1; while (b < sk.length && t0[b] === null) b++;
    const ta = a >= 0 ? t1[a] : 0.05, tb = b < sk.length ? t0[b] : duration - 0.05;
    const n = (b - a); const k = i - a;
    t0[i] = ta + (tb - ta) * (k - 1) / Math.max(1, n - 1); t1[i] = ta + (tb - ta) * k / Math.max(1, n - 1);
  }
  return {t0, t1, matched, length: sk.length};
}

/** Given sentences (with optional card index) build cues/focus relative to audio start. */
export function timeSegment(sentences, words, duration, {maxUnits = 22} = {}) {
  const full = sentences.map(s => s.text).join('');
  const ct = charTimes(full, words, duration);
  const cues = []; const sentRanges = [];
  let pos = 0; // skeleton position
  for (const s of sentences) {
    const sStart = pos;
    for (const ch of subtitleChunks(s.text, maxUnits)) {
      const len = skeletonChars(ch).length; if (!len) continue;
      const a = Math.min(pos, ct.length - 1), b = Math.min(pos + len - 1, ct.length - 1);
      cues.push({text: displayChunk(ch), a: ct.t0[a], b: ct.t1[b]});
      pos += len;
    }
    sentRanges.push({card: s.card, media: s.media, a: ct.t0[Math.min(sStart, ct.length - 1)], b: ct.t1[Math.min(pos - 1, ct.length - 1)]});
  }
  // cue i ends where cue i+1 starts (no flicker); last cue holds a little after speech
  for (let i = 0; i < cues.length; i++) cues[i].end = i + 1 < cues.length ? cues[i + 1].a : Math.min(duration + .35, cues[i].b + .6);
  return {cues: cues.map(c => ({text: c.text, t0: Math.max(0, c.a - .05), t1: c.end})), sentences: sentRanges, matchRatio: ct.matched};
}

/** Synthesize all segments. segs: [{id, sentences:[{text,card?}]}]. Returns per-id {file, duration, words}. */
export async function synthesize(segs, {cfg, outDir}) {
  await fsp.mkdir(outDir, {recursive: true});
  const tcfg = cfg.tts || {};
  const provider = tcfg.provider || 'edge';
  const ext = provider === 'gptsovits' || provider === 'qwen3' ? 'wav' : 'mp3';
  const voiceKey = provider === 'gptsovits' ? `gsv|${tcfg.gptsovits?.voice}|${tcfg.gptsovits?.speed}` : provider === 'qwen3' ? `q3|${tcfg.qwen3?.voice}|${tcfg.qwen3?.pause}|x${tcfg.qwen3?.speed ?? 1}` : provider === 'minimax' ? `mm|${tcfg.minimax?.voiceId}|${tcfg.minimax?.speed}` : `${tcfg.voice}|${tcfg.rate}|${tcfg.pitch}`;
  const items = [];
  const revoice = await readJson(path.join(outDir, 'revoice.json'), {}); // 工作台里标记「这句重念」的句子 {段id: {句号: 次数}}
  for (const s of segs) {
    const out = path.join(outDir, `${s.id}.${ext}`);
    const text = ttsText(s.sentences.map(x => x.text).join(''));
    const hashFile = out + '.txt';
    const rv = Object.keys(revoice[s.id] || {}).length ? `|rv${JSON.stringify(revoice[s.id])}` : '';
    const key = `${voiceKey}|${text}${rv}`;
    if (exists(out) && exists(out + '.json') && exists(hashFile) && fs.readFileSync(hashFile, 'utf8') === key) continue; // cached
    items.push({id: s.id, text, out, reseed: revoice[s.id]});
    await fsp.writeFile(hashFile, key);
  }
  if (items.length && provider === 'gptsovits') {
    try { await gsvSynthesize(segs, items, tcfg); }
    catch (e) { for (const x of items) { try { fs.unlinkSync(x.out + '.txt'); } catch {} } throw e; }
  } else if (items.length && provider === 'qwen3') {
    try { await qwen3Synthesize(segs, items, tcfg, outDir); await speedUp(items, tcfg.qwen3?.speed ?? 1, cfg); }
    catch (e) { for (const x of items) { try { fs.unlinkSync(x.out + '.txt'); } catch {} } throw e; }
  } else if (items.length && provider === 'minimax') {
    log(`配音：MiniMax 合成 ${items.length} 段（${tcfg.minimax?.voiceId}）…`);
    for (const it of items) {
      try { await minimaxOne(it, tcfg); }
      catch (e) { for (const x of items) { try { fs.unlinkSync(x.out + '.txt'); } catch {} } throw new Error('MiniMax 配音失败：' + e.message); }
    }
  } else if (items.length) {
    const py = await findPython(cfg);
    const job = path.join(outDir, '_job.json');
    await writeJson(job, {voice: tcfg.voice || 'zh-CN-XiaoxiaoNeural', rate: tcfg.rate || '+5%', pitch: tcfg.pitch || '+0Hz', volume: tcfg.volume || '+0%', concurrency: tcfg.concurrency || 4, items});
    log(`配音：合成 ${items.length} 段（${tcfg.voice}）…`);
    const r = await run(py.exe, [...py.pre, path.join(HERE, 'tts_edge.py'), job], {timeoutMs: 15 * 60 * 1000, env: {PYTHONIOENCODING: 'utf-8'}});
    if (r.code !== 0) {
      for (const it of items) { try { fs.unlinkSync(it.out + '.txt'); } catch {} }
      throw new Error('配音失败：' + (r.out + r.err).slice(-1200));
    }
  }
  const res = {};
  for (const s of segs) {
    const out = path.join(outDir, `${s.id}.${ext}`);
    const meta = await readJson(out + '.json');
    res[s.id] = {file: out, words: meta.words};
  }
  return res;
}

/** Mix per-segment mp3 files at given start times into one 48k mono wav, loudness-normalized. */
export async function mixNarration({ffmpeg, placements, total, outFile, bgm}) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  placements.forEach(p => args.push('-i', p.file));
  const filters = placements.map((p, i) => `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,adelay=${Math.round(p.at * 1000)}:all=1[a${i}]`);
  let mixInputs = placements.map((_, i) => `[a${i}]`).join('');
  filters.push(`${mixInputs}amix=inputs=${placements.length}:normalize=0:dropout_transition=0,apad,atrim=duration=${total.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11[voice]`);
  let outLabel = '[voice]';
  if (bgm && exists(bgm.file)) {
    args.push('-stream_loop', '-1', '-i', bgm.file);
    const bi = placements.length;
    filters.push(`[${bi}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,volume=${bgm.volume ?? 0.08},atrim=duration=${total.toFixed(3)},afade=t=out:st=${Math.max(0, total - 3).toFixed(2)}:d=3[bg]`);
    filters.push(`[voice][bg]amix=inputs=2:normalize=0:duration=first[mix]`); outLabel = '[mix]';
  }
  args.push('-filter_complex', filters.join(';'), '-map', outLabel, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', outFile);
  const r = await run(ffmpeg, args, {timeoutMs: 10 * 60 * 1000});
  if (r.code !== 0) throw new Error('混音失败: ' + r.err.slice(-800));
  return outFile;
}

export {ffprobeDuration};

// ---------- MiniMax (optional, paid) ----------
async function minimaxOne(it, tcfg) {
  const m = tcfg.minimax || {};
  const key = m.apiKey || process.env.MINIMAX_API_KEY; if (!key) throw new Error('缺少 MiniMax API Key（config.local.json 的 tts.minimax.apiKey）');
  const body = {model: m.model || 'speech-02-hd', text: it.text, stream: false, language_boost: 'Chinese', output_format: 'hex', subtitle_enable: true, subtitle_type: 'word',
    voice_setting: {voice_id: m.voiceId || 'female-chengshu', speed: m.speed ?? 1.05, vol: 1, pitch: m.pitch ?? 0, ...(m.emotion ? {emotion: m.emotion} : {})},
    audio_setting: {sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1}};
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch((m.baseUrl || 'https://api.minimaxi.com') + '/v1/t2a_v2', {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${key}`}, body: JSON.stringify(body), signal: AbortSignal.timeout(120000)});
      const j = await res.json();
      if (j.base_resp?.status_code !== 0 || !j.data?.audio) throw new Error(`${j.base_resp?.status_code} ${j.base_resp?.status_msg || res.status}`);
      fs.writeFileSync(it.out, Buffer.from(j.data.audio, 'hex'));
      let words = [];
      if (j.data.subtitle_file) {
        try {
          const sub = await (await fetch(j.data.subtitle_file, {signal: AbortSignal.timeout(30000)})).json();
          const list = Array.isArray(sub) ? sub : (sub.subtitles || sub.data || []);
          words = list.map(x => ({t0: (x.time_begin ?? x.start ?? 0) / 1000, t1: (x.time_end ?? x.end ?? 0) / 1000, text: x.text || '', kind: 'WordBoundary'})).filter(w => w.text && w.t1 > w.t0);
        } catch {}
      }
      fs.writeFileSync(it.out + '.json', JSON.stringify({id: it.id, words}));
      return;
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); }
  }
  throw lastErr;
}

// ---------- Qwen3-TTS (local, free; clones the sample.wav of a voice pack in ai-daily/voices/<名字>/) ----------
async function qwen3Synthesize(segs, items, tcfg, outDir) {
  const q = tcfg.qwen3 || {};
  if (!q.python || !fs.existsSync(q.python)) throw new Error(`未配置 Qwen3-TTS：请在 config.local.json 填写 tts.qwen3.python（qwen3-tts 环境里 python 的完整路径）${q.python ? `，现在填的 ${q.python} 不存在` : ''}；或者把 tts.provider 改成 edge（免费，不需要显卡）`);
  const dir = path.join(ROOT, 'voices', q.voice || '');
  const vj = path.join(dir, 'voice.json');
  if (!q.voice || !fs.existsSync(vj)) throw new Error(`找不到 Qwen3 声音包：${dir}（tts.qwen3.voice 填 voices 文件夹里的声音包名，见 docs/setup.md）`);
  const meta = JSON.parse(fs.readFileSync(vj, 'utf8').replace(/^﻿/, ''));
  const py = q.python;
  if (!(q.model || meta.model)) throw new Error('未配置 Qwen3-TTS 模型：请在 tts.qwen3.model 填模型文件夹（或 Hugging Face 模型名），见 docs/setup.md');
  const job = path.join(outDir, '_job_qwen3.json');
  await writeJson(job, {model: q.model || meta.model, ref: path.join(dir, meta.ref), refText: meta.refText, pause: q.pause ?? .22, minSim: q.minSim ?? .975, tries: q.tries ?? 3, seed: q.seed ?? 42,
    items: items.map(it => ({id: it.id, out: it.out, reseed: it.reseed, sentences: segs.find(s => s.id === it.id).sentences.map(x => ttsText(x.text)).filter(Boolean)}))});
  log(`配音：Qwen3「${q.voice}」合成 ${items.length} 段（一句一句念，自动质检）…`);
  const r = await run(py, ['-I', path.join(HERE, 'tts_qwen3.py'), job], {timeoutMs: (q.timeoutMin || 180) * 60 * 1000, env: {PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1'},
    onLine: l => { if (/^(OK|RETRY|WARN|DONE)/.test(l)) log('  ' + l); }});
  if (r.code !== 0) throw new Error('Qwen3 配音失败：' + (r.out + r.err).slice(-1500));
}

/** 整体加快语速（音调不变），字幕时间同步缩短。speed=1.25 即 1.25 倍速。 */
async function speedUp(items, speed, cfg) {
  if (!(speed > 0) || speed === 1) return;
  const {ffmpeg} = findFfmpeg(cfg);
  for (const it of items) {
    const tmp = it.out + '.speed.wav';
    const r = await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', it.out, '-filter:a', `atempo=${speed}`, '-c:a', 'pcm_s16le', tmp], {timeoutMs: 120000});
    if (r.code !== 0) throw new Error('加快语速失败：' + r.err.slice(-500));
    await fsp.rename(tmp, it.out);
    const meta = await readJson(it.out + '.json');
    for (const w of meta.words || []) { w.t0 /= speed; w.t1 /= speed; }
    await writeJson(it.out + '.json', meta);
  }
  log(`配音：已整体加快到 ${speed} 倍速`);
}

// ---------- GPT-SoVITS (local, free; uses a voice pack in ai-daily/voices/<名字>/) ----------

export function findVoicePack(name) {
  const dir = path.isAbsolute(name || '') ? name : path.join(ROOT, 'voices', name || '');
  if (!name || !fs.existsSync(dir)) throw new Error(`找不到声音包：${dir}（把 GPT-SoVITS 模型文件夹放进 ai-daily\\voices\\ 并在 config.json 的 tts.gptsovits.voice 填文件夹名）`);
  const all = []; (function walk(d) { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else all.push(p); } })(dir);
  let meta = {}; const vj = path.join(dir, 'voice.json');
  if (fs.existsSync(vj)) meta = JSON.parse(fs.readFileSync(vj, 'utf8').replace(/^﻿/, ''));
  const abs = p => p ? (path.isAbsolute(p) ? p : path.join(dir, p)) : null;
  const gpt = abs(meta.gpt) || all.find(p => /\.ckpt$/i.test(p));
  const sovits = abs(meta.sovits) || all.find(p => /\.pth$/i.test(p));
  const audios = all.filter(p => /\.(wav|mp3|ogg|flac)$/i.test(p));
  const ref = abs(meta.ref) || audios.find(p => /平静|默认|正常|neutral|default|normal/i.test(path.basename(p))) || audios[0];
  if (!gpt || !sovits || !ref) throw new Error(`声音包不完整（需要 .ckpt、.pth 和一段 3–10 秒参考音频）：${dir}`);
  const refText = meta.refText ?? path.basename(ref).replace(/\.[^.]+$/, '').replace(/^[\[【(（][^\]】)）]*[\]】)）]\s*/, '').replace(/^[\d_\-\s]+/, '').trim();
  return {dir, gpt, sovits, ref, refText, refLang: meta.refLang || 'zh', speed: meta.speed};
}

async function httpOk(url) { try { const r = await fetch(url, {signal: AbortSignal.timeout(3000)}); return r.status > 0; } catch { return false; } }

async function gsvServer(g) {
  const base = `http://127.0.0.1:${g.port || 9880}`;
  if (await httpOk(base + '/tts')) return {base, child: null};
  if (!g.dir || !fs.existsSync(path.join(g.dir, 'api_v2.py'))) throw new Error('GPT-SoVITS 没在运行，且 config 里的 tts.gptsovits.dir 不是 GPT-SoVITS 整合包目录');
  const py = g.python || [path.join(g.dir, 'runtime', 'python.exe'), 'python'].find(p => p === 'python' || fs.existsSync(p));
  log('启动 GPT-SoVITS 接口服务…');
  const logFd = fs.openSync(path.join(g.dir, 'ai-daily-api.log'), 'a');
  const child = spawnProc(py, ['api_v2.py', '-a', '127.0.0.1', '-p', String(g.port || 9880), '-c', 'GPT_SoVITS/configs/tts_infer.yaml'], {cwd: g.dir, stdio: ['ignore', logFd, logFd], windowsHide: true});
  for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 2000)); if (await httpOk(base + '/tts')) return {base, child}; if (child.exitCode !== null) break; }
  throw new Error('GPT-SoVITS 服务启动失败，日志见 ' + path.join(g.dir, 'ai-daily-api.log'));
}

function wavInfo(buf) {
  let o = 12, fmt = null, data = null;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4); const size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = {channels: buf.readUInt16LE(o + 10), rate: buf.readUInt32LE(o + 12), byteRate: buf.readUInt32LE(o + 16), align: buf.readUInt16LE(o + 20), bits: buf.readUInt16LE(o + 22)};
    if (id === 'data') { const end = size === 0xffffffff || o + 8 + size > buf.length ? buf.length : o + 8 + size; data = buf.subarray(o + 8, end); break; }
    o += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('GPT-SoVITS 返回的不是 wav');
  return {fmt, data};
}
function wavHeader(fmt, dataLen) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataLen, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(fmt.channels, 22); h.writeUInt32LE(fmt.rate, 24); h.writeUInt32LE(fmt.byteRate, 28); h.writeUInt16LE(fmt.align, 32); h.writeUInt16LE(fmt.bits, 34);
  h.write('data', 36); h.writeUInt32LE(dataLen, 40); return h;
}

export async function gsvSynthesize(segs, items, tcfg) {
  const g = tcfg.gptsovits || {};
  const v = findVoicePack(g.voice);
  const {base, child} = await gsvServer(g);
  try {
    const q = async (ep, p) => { const r = await fetch(`${base}${ep}?weights_path=${encodeURIComponent(p)}`, {signal: AbortSignal.timeout(180000)}); if (!r.ok) throw new Error(`${ep} 失败：${(await r.text()).slice(0, 200)}`); };
    await q('/set_gpt_weights', v.gpt); await q('/set_sovits_weights', v.sovits);
    log(`配音：GPT-SoVITS「${path.basename(v.dir)}」合成 ${items.length} 段…`);
    for (const it of items) {
      const seg = segs.find(s => s.id === it.id);
      const parts = []; const words = []; let fmt = null, t = 0;
      for (const sent of seg.sentences) {
        const text = ttsText(sent.text); if (!text) continue;
        let buf, lastErr;
        for (let a = 0; a < 3 && !buf; a++) {
          try {
            const r = await fetch(base + '/tts', {method: 'POST', headers: {'content-type': 'application/json'}, signal: AbortSignal.timeout(180000),
              body: JSON.stringify({text, text_lang: 'zh', ref_audio_path: v.ref, prompt_text: v.refText, prompt_lang: v.refLang, text_split_method: 'cut5', batch_size: 1, media_type: 'wav', streaming_mode: false,
                speed_factor: g.speed ?? v.speed ?? 1.0, top_k: g.topK ?? 15, top_p: g.topP ?? 1, temperature: g.temperature ?? 1, repetition_penalty: 1.35, seed: g.seed ?? 42, parallel_infer: true})});
            if (!r.ok) throw new Error((await r.text()).slice(0, 300));
            buf = Buffer.from(await r.arrayBuffer());
          } catch (e) { lastErr = e; }
        }
        if (!buf) throw new Error('GPT-SoVITS 合成失败：' + lastErr?.message);
        const w = wavInfo(buf); fmt = fmt || w.fmt;
        const dur = w.data.length / w.fmt.byteRate;
        words.push({t0: t, t1: t + dur, text: sent.text, kind: 'WordBoundary'});
        parts.push(w.data);
        const gap = Buffer.alloc(Math.round(fmt.byteRate * (g.pause ?? .12) / fmt.align) * fmt.align);
        parts.push(gap); t += dur + gap.length / fmt.byteRate;
      }
      const data = Buffer.concat(parts);
      fs.writeFileSync(it.out, Buffer.concat([wavHeader(fmt, data.length), data]));
      fs.writeFileSync(it.out + '.json', JSON.stringify({id: it.id, words}));
    }
  } finally { if (child && !g.keepServer) { try { child.kill(); } catch {} } }
}
