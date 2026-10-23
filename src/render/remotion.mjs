// 竖屏出片（Remotion，项目在 ../remotion-lab）。两步：
// 1. prepareRemotion：配音做完后，把这一期整理成 remotion-lab/public/ep/<期>/episode.json（每条新闻按句子分成 4 种场景、主持人嘴型、一句话总结的配音），
//    同时算出竖屏版每段的开始时间（多了开场 1.6 秒和每条的总结），返回一个「竖屏时间轴」给 publishInfo 算章节。
// 2. renderRemotion：调用 npx remotion render 出成片（画面和声音一起出）。
// 每条新闻的补充字段（大数字、一句话总结、印章字…）放在 stories-written.json 的 story.portrait，或 runs/<期>/portrait-extra.json（按新闻 id，优先）。没有也能出，只是少了 A 场景和总结。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ROOT, readJson, writeJson, exists, log, run, ffprobeDuration} from '../util.mjs';
import {synthesize, timeSegment} from '../tts/tts.mjs';
import {mouthTrack, HOST} from './portrait.mjs';
import {brandsIn, logoData} from './logos.mjs';

export const LAB = ROOT; // Remotion project root (entry: remotion/index.ts, assets: public/)
const FPS = 30;
const STING = 1.6; // 开场频道名亮相；「咔哒」在这之后、正片开头响一次
const LEAD = {intro: .35, item: .5, outro: .45}; // 和 timeline.mjs 里每段配音前留的空一致

const r3 = x => Math.round(x * 1000) / 1000;

/** 每句话用哪个场景：配图/推文出现的句子 → B；讲到大数字的句子 → A；其余 → C（卡片）。相邻同场景合并成一拍。 */
function planBeats(sents, {hero, media}) {
  const digits = hero?.v ? (hero.v.match(/[0-9]+(?:\.[0-9]+)?/) || [])[0] : null;
  // 找讲到这个数字的句子；型号里的数字（M3.1 里的 3）不算
  const re = digits ? new RegExp(`(?<![A-Za-z0-9.])${digits.replace('.', '\\.')}(?![0-9]|\\.[0-9])`) : null;
  let heroIdx = re ? sents.findIndex(s => re.test(s.text)) : -1;
  if (hero?.v && heroIdx < 0) heroIdx = 0; // 大数字没在稿子里出现：放在第一句
  const out = [];
  sents.forEach((s, i) => {
    const mid = (s.a + s.b) / 2;
    const mi = media.findIndex(m => mid >= m.t0 - .2 && mid <= m.t1 + .2);
    let b;
    if (mi >= 0) b = {scene: 'B', media: mi};
    else if (i === heroIdx) b = {scene: 'A'};
    else if (i === 0 && media.length && !out.some(x => x.scene === 'B')) b = {scene: 'B', media: 0};
    else b = {scene: 'C'};
    const last = out[out.length - 1];
    if (last && last.scene === b.scene && last.media === b.media) { last.t1 = s.b; if (s.card >= 0) last.cards.push({card: s.card, t0: s.a}); }
    else out.push({...b, t0: s.a, t1: s.b, cards: s.card >= 0 ? [{card: s.card, t0: s.a}] : []});
  });
  // 拍和拍之间不留缝：每拍一直持续到下一拍开始
  out.forEach((b, i) => { b.t0 = i === 0 ? 0 : b.t0; if (out[i + 1]) b.t1 = out[i + 1].t0; });
  return out;
}

async function copyTo(src, dir, name) {
  const dst = path.join(dir, name);
  await fsp.copyFile(src, dst);
  return dst;
}

/** 背景音乐（render.portrait.bgm）：做一条正好整期长的 bgm.wav。全程恒定音量、说话时不压低（忽大忽小很突兀），
 *  先轻压缩抹平歌本身的起伏；开头淡入、结尾淡出；歌比视频短就首尾交叉淡化循环。没配或出错就不加，不影响出片。 */
export async function makeBgm({cfg, ffmpeg, ffprobe, epDir, epKey, duration}) {
  const b = cfg.render?.portrait?.bgm;
  if (!b?.file) return null;
  const src = path.resolve(ROOT, b.file);
  if (!exists(src)) { log(`背景音乐文件不存在，这期不加：${src}`); return null; }
  const len = await ffprobeDuration(ffprobe, src);
  const xf = b.crossfade ?? 3, fadeIn = b.fadeIn ?? 1.5, fadeOut = b.fadeOut ?? 3;
  const n = len >= duration ? 1 : Math.ceil((duration - xf) / (len - xf));
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (let i = 0; i < n; i++) args.push('-i', src);
  const f = [];
  let last = '[0:a]';
  for (let i = 1; i < n; i++) { f.push(`${last}[${i}:a]acrossfade=d=${xf}[x${i}]`); last = `[x${i}]`; }
  f.push(`${last}aresample=48000,atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS,acompressor=threshold=-22dB:ratio=3:attack=200:release=1500,`
    + `volume=${b.gainDb ?? -10}dB,afade=t=in:d=${fadeIn},afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(3)}:d=${fadeOut}[bg]`);
  args.push('-filter_complex', f.join(';'), '-map', '[bg]', '-ac', '2', path.join(epDir, 'bgm.wav'));
  const r = await run(ffmpeg, args);
  if (r.code !== 0) { log('背景音乐处理失败，这期不加：' + r.err.slice(-300)); return null; }
  log(`背景音乐：${path.basename(src)}（${Math.round(len)} 秒${n > 1 ? `，循环 ${n} 遍` : ''}），音量 ${b.gainDb ?? -10} dB`);
  return `${epKey}/bgm.wav`;
}

/** Quote one argument for the Windows shell (npx.cmd needs shell: true), so paths with spaces stay whole. */
export const shellQuote = a => /[\s&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a;

/** Voice-over file of one segment: .wav (Qwen3-TTS, GPT-SoVITS) or .mp3 (Edge TTS, MiniMax). */
export function segmentAudio(runDir, id) {
  for (const ext of ['wav', 'mp3']) { const p = path.join(runDir, 'audio', `${id}.${ext}`); if (exists(p)) return p; }
  throw new Error(`找不到配音文件：${path.join(runDir, 'audio', id)}.wav / .mp3（请从配音这一步重做：--from voice）`);
}

/** Remotion reads public/: copy the host images (config.host.dir) to public/host and synthesize public/sfx/click.wav. */
export async function syncPublicAssets() {
  const hostOut = path.join(LAB, 'public', 'host');
  await fsp.rm(hostOut, {recursive: true, force: true});
  await fsp.mkdir(hostOut, {recursive: true});
  for (const f of await fsp.readdir(HOST.dir)) if (/\.png$/i.test(f)) await fsp.copyFile(path.join(HOST.dir, f), path.join(hostOut, f));
  if (!exists(path.join(LAB, 'public', 'sfx', 'click.wav'))) { await fsp.mkdir(path.join(LAB, 'public', 'sfx'), {recursive: true}); await run(process.execPath, [path.join(ROOT, 'scripts', 'make-click.mjs')]); }
}

/** 整理一期的 Remotion 数据。返回 {epKey, episode, timeline}，timeline 是竖屏版时间（给 publishInfo 算章节、目录）。 */
export async function prepareRemotion(timeline, stories, {cfg, runDir, dp, ffmpeg, ffprobe}) {
  const runName = path.basename(runDir);
  const epKey = `ep/${runName}`;
  const epDir = path.join(LAB, 'public', 'ep', runName);
  await fsp.rm(epDir, {recursive: true, force: true});
  await fsp.mkdir(path.join(epDir, 'media'), {recursive: true});
  await syncPublicAssets();
  const extraFile = await readJson(path.join(runDir, 'portrait-extra.json'), {});
  const byId = Object.fromEntries(stories.map(s => [s.id, s]));
  // 「一句话总结」开关（render.portrait.conclusion，默认关）：关着就当没有 comment、stamp → 不配音、不出 D 场景，讲完直接接下一条
  const conclusionOn = cfg.render?.portrait?.conclusion === true;
  const extraOf = id => { const x = {...(byId[id]?.portrait || {}), ...(extraFile[id] || {})}; return conclusionOn ? x : {...x, comment: '', stamp: ''}; };

  // 一句话总结要单独配音（同一个声音），放 runs/<期>/audio-portrait/
  const conclSegs = timeline.segments.filter(s => s.type === 'item' && extraOf(s.id).comment).map(s => ({id: `${s.id}-c`, sentences: [{text: extraOf(s.id).comment.replace(/\n/g, ''), card: -1}]}));
  const concl = conclSegs.length ? await synthesize(conclSegs, {cfg, outDir: path.join(runDir, 'audio-portrait')}) : {};

  const segs = [];
  let at = STING;
  const items = timeline.segments.filter(s => s.type === 'item');
  for (const seg of timeline.segments) {
    const audioSrc = segmentAudio(runDir, seg.id), audioName = seg.id + path.extname(audioSrc);
    const dur = await ffprobeDuration(ffprobe, audioSrc);
    await copyTo(audioSrc, epDir, audioName);
    const aud = seg.start + LEAD[seg.type];
    const x = extraOf(seg.id);
    const base = {type: seg.type, id: seg.id, audio: `${epKey}/${audioName}`, duration: r3(dur)};
    if (seg.type === 'item') {
      const st = byId[seg.id];
      const words = (await readJson(audioSrc + '.json')).words;
      const tm = timeSegment(st.narration, words, dur, {maxUnits: 16});
      const sents = tm.sentences.map((s, i) => ({...s, text: st.narration[i]?.text || ''}));
      // 配图、推文：时间换成相对这条配音开头；图片复制到 public
      const media = [];
      for (const m of seg.media || []) {
        const t0 = r3(m.t0 - aud), t1 = r3(m.t1 - aud);
        if (m.type === 'tweet') { media.push({kind: 'tweet', name: m.name, handle: m.handle, textZh: m.textZh, date: m.date, t0, t1}); continue; }
        const file = path.resolve(runDir, '_page', m.src);
        if (!exists(file)) continue;
        const name = path.basename(file);
        await copyTo(file, path.join(epDir, 'media'), name);
        media.push({kind: 'image', src: `${epKey}/media/${name}`, caption: m.caption || '', t0, t1});
      }
      const brand = brandsIn(`${x.ribbon || ''} ${seg.title}`)[0];
      const pad = .3, tail = .35;
      const item = {
        ...base, no: items.indexOf(seg) + 1, title: seg.title, short: seg.short, sourceLine: seg.sourceLine || '',
        tab: x.tab || (brand ? brand[0].toUpperCase() + brand.slice(1) : seg.short), ribbon: x.ribbon || st.coverTitle || seg.title, ribbonSub: x.ribbonSub || seg.sourceLine || '',
        logo: brand ? logoData(brand) : null, cards: seg.cards || [], hero: x.hero || null, chip: x.chip || null, comment: x.comment || '', stamp: x.stamp || '',
        media, offset: pad, cues: tm.cues.map(c => ({text: c.text, t0: r3(c.t0), t1: r3(c.t1)})),
        mouth: await mouthTrack({ffmpeg, audio: audioSrc, cues: tm.cues, duration: dur, fps: 15}),
        beats: planBeats(sents, {hero: x.hero, media}).map(b => ({...b, t0: r3(b.t0), t1: r3(b.t1)})),
        from: r3(at), len: r3(pad + dur + tail),
      };
      at += item.len;
      const c = concl[`${seg.id}-c`];
      if (c) {
        const cdur = await ffprobeDuration(ffprobe, c.file);
        const cName = `${seg.id}-c${path.extname(c.file)}`;
        await copyTo(c.file, epDir, cName);
        const cw = (await readJson(c.file + '.json')).words;
        const ctm = timeSegment([{text: item.comment.replace(/\n/g, ''), card: -1}], cw, cdur, {maxUnits: 16});
        item.concl = {audio: `${epKey}/${cName}`, duration: r3(cdur), offset: .25, from: r3(at), len: r3(.25 + cdur + 1.1), mouth: await mouthTrack({ffmpeg, audio: c.file, cues: ctm.cues, duration: cdur, fps: 15}), speak: ctm.sentences[0] ? {t0: r3(ctm.sentences[0].a), t1: r3(ctm.sentences[0].b)} : {t0: 0, t1: cdur}};
        at += item.concl.len;
      }
      item.end = r3(at);
      segs.push(item);
    } else {
      // 开场、结尾沿用横屏时间轴的字幕，换成相对这段配音开头
      const pad = seg.type === 'intro' ? .2 : .3, tail = seg.type === 'intro' ? .5 : 2.2;
      const s = {...base, offset: pad, cues: (seg.cues || []).map(c => ({text: c.text, t0: r3(c.t0 - aud), t1: r3(c.t1 - aud)})), from: r3(at), len: r3(Math.max(pad + dur + tail, seg.type === 'intro' ? 4 : 3.5))};
      s.mouth = await mouthTrack({ffmpeg, audio: audioSrc, cues: s.cues, duration: dur, fps: 15});
      if (seg.type === 'intro') s.list = items.map(it => { const b = brandsIn(`${extraOf(it.id).ribbon || ''} ${it.title}`)[0]; return {title: it.title, logo: b ? logoData(b) : null}; });
      at += s.len; s.end = r3(at);
      segs.push(s);
    }
  }
  const episode = {
    fps: FPS, sting: STING, duration: r3(at), channel: cfg.channel?.titleSign || cfg.channel?.name || 'My AI News', column: timeline.channel?.name || '每日AI要闻',
    dateLabel: timeline.dateLabel, dateShort: `${dp.m}.${String(dp.d).padStart(2, '0')}`, itemCount: items.length, segments: segs,
    bgm: await makeBgm({cfg, ffmpeg, ffprobe, epDir, epKey, duration: r3(at)}),
  };
  await writeJson(path.join(epDir, 'episode.json'), episode);
  // 竖屏版时间轴：每段的开始/结束换成竖屏视频里的时间（章节、目录用）
  const pt = {...timeline, width: 1080, height: 1920, duration: episode.duration, segments: timeline.segments.map((s, i) => ({...s, start: i === 0 ? 0 : segs[i].from, end: segs[i].end}))};
  await writeJson(path.join(runDir, 'timeline-remotion.json'), pt);
  log(`竖屏数据整理完成：${segs.length} 段，总时长 ${Math.round(episode.duration)} 秒（${epDir}）`);
  return {epKey, episode, timeline: pt};
}

/** 成片整体响度（render.portrait.loudness，默认 -16 LUFS）：量出整体响度，整段加同一个增益，不压动态，
 *  人声、背景音乐、咔哒的比例不变；alimiter 只防个别瞬间爆音（level=0 不自动拉响度）。只重编码音频（aac 48k，和 Remotion 原来一致），
 *  先写临时文件，时长和音轨数对得上才替换；差不到 1 dB 就跳过；出错保留原片、只记日志。 */
export async function normalizeLoudness({ffmpeg, ffprobe, file, target}) {
  const m = await run(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const sum = m.err.slice(m.err.lastIndexOf('Summary'));
  const I = parseFloat((sum.match(/I:\s*(-?[\d.]+) LUFS/) || [])[1]);
  if (!Number.isFinite(I)) { log('量不出成片响度，保持原样：' + m.err.slice(-300)); return null; }
  const gain = Math.round((target - I) * 10) / 10;
  if (Math.abs(gain) < 1) { log(`成片响度 ${I} LUFS，离目标 ${target} 不到 1 dB，不调`); return {I, gain: 0}; }
  const tmp = file.replace(/\.mp4$/i, '') + '.loud.mp4';
  const r = await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v', '-map', '0:a', '-c:v', 'copy',
    '-af', `volume=${gain}dB,alimiter=limit=0.84:level=0:attack=5:release=50`, '-c:a', 'aac', '-ar', '48000', '-b:a', '320k', tmp]);
  const ok = r.code === 0 && exists(tmp)
    && Math.abs(await ffprobeDuration(ffprobe, tmp) - await ffprobeDuration(ffprobe, file)) < .1
    && (await run(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', tmp])).out.trim().split(/\r?\n/).length === 1;
  if (!ok) { await fsp.rm(tmp, {force: true}); log('调整成片响度失败，保持原样：' + r.err.slice(-300)); return null; }
  await fsp.rename(tmp, file);
  log(`成片响度 ${I} → 约 ${target} LUFS（整体 ${gain > 0 ? '+' : ''}${gain} dB）`);
  return {I, gain};
}

/** 调用 Remotion 出成片（画面 + 声音）。给了 loudness 就出片后把整体响度调到这个值。 */
export async function renderRemotion({epKey, outFile, concurrency, onLine, ffmpeg, ffprobe, loudness}) {
  const props = path.join(LAB, 'public', epKey, 'props.json');
  await fsp.writeFile(props, JSON.stringify({ep: epKey}));
  const args = ['remotion', 'render', 'remotion/index.ts', 'DailyPortrait', outFile, `--props=${props}`, ...(concurrency ? [`--concurrency=${concurrency}`] : [])];
  const started = Date.now();
  const win = process.platform === 'win32';
  await new Promise((res, rej) => {
    const p = spawn(win ? 'npx.cmd' : 'npx', win ? args.map(shellQuote) : args, {cwd: LAB, shell: win, windowsHide: true});
    let tail = '';
    const on = d => { const s = String(d); tail = (tail + s).slice(-2000); for (const line of s.split(/\r?\n/)) if (line.trim()) onLine?.(line.trim()); };
    p.stdout.on('data', on); p.stderr.on('data', on);
    p.on('close', c => c === 0 ? res() : rej(new Error('Remotion 出片失败：' + tail.slice(-800))));
  });
  if (ffmpeg && Number.isFinite(loudness)) await normalizeLoudness({ffmpeg, ffprobe, file: outFile, target: loudness});
  return {seconds: (Date.now() - started) / 1000};
}
