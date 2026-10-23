// 手动工作台：把每日资讯当成三大模块的流水线（信息采集 → 视频编辑 → 上传），每一块都能由人审核、修改，
// 改完写回 runs/<期>/ 里的 json，再让 main.mjs 从下一步接着跑。全自动只是三块都不停下的一种跑法。
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ROOT, readJson, writeJson, exists, loadConfig, dateParts, fetchText} from '../util.mjs';
import {CHAPTERS, buildCandidates} from '../rank.mjs';
import {ICON_NAMES} from '../write.mjs';
import {extractArticle, imageSize} from '../enrich.mjs';
import {getColumn, columnList, runNameFor} from '../columns.mjs';
import {buildGithubCandidates, recentRepos} from '../github.mjs';
import {translateRun, loadTranslations, zhOf, summaryText} from '../translate.mjs';
const chaptersOf = name => getColumn(loadConfig(), {run: name}).chapters; // 这一期所属板块的栏目

const RUNS = path.join(ROOT, 'runs');
const PAGE = path.join(ROOT, 'src', 'workbench', 'index.html');
const WORKFLOW = path.join(ROOT, 'workflow.json');
const argv = process.argv.slice(2);
const PORT = Number(argv.find(a => /^\d+$/.test(a)) || 3220);
const TYPES = {'.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.wav': 'audio/wav', '.mp3': 'audio/mpeg'};

// ---------- 小工具 ----------
const RUN_RE = /^\d{4}-\d{2}-\d{2}[\p{L}\p{N}_-]*$/u;
function runDir(name) {
  if (!RUN_RE.test(name || '')) throw httpError(400, '期数名称不对');
  const d = path.join(RUNS, name); if (!exists(d)) throw httpError(404, '没有这一期：' + name); return d;
}
function httpError(code, msg) { const e = new Error(msg); e.status = code; return e; }
const mtime = p => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
const finalVideo = dir => fs.readdirSync(dir).find(f => /^\d{4}-\d{2}-\d{2}-.+\.mp4$/.test(f)) || null;
const rel = (dir, file) => path.relative(dir, file).split(path.sep).join('/');
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
async function backupOnce(dir, file) { // 第一次手动保存前，把 AI 原版留一份
  const src = path.join(dir, file), dst = path.join(dir, file.replace('.json', '.ai原版.json'));
  if (exists(src) && !exists(dst)) await fsp.copyFile(src, dst);
}
async function readLines(file) { try { return (await fsp.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean); } catch { return []; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

// ---------- 流程开关 ----------
async function getWorkflow() { return {collectReview: true, editReview: true, ...await readJson(WORKFLOW, {})}; }
async function saveWorkflow(b) {
  const wf = await getWorkflow();
  for (const k of ['collectReview', 'editReview']) if (typeof b[k] === 'boolean') wf[k] = b[k];
  await writeJson(WORKFLOW, wf); return wf;
}

// ---------- 后台任务（让 main.mjs 接着跑） ----------
const jobFile = dir => path.join(dir, 'workbench-job.json');
async function currentJob(dir) {
  const j = await readJson(jobFile(dir), null);
  if (j && j.running && !alive(j.pid)) { j.running = false; await writeJson(jobFile(dir), j); }
  return j;
}
async function anyRunningJob() {
  for (const n of fs.readdirSync(RUNS)) {
    if (!RUN_RE.test(n)) continue;
    const j = await currentJob(path.join(RUNS, n)); if (j?.running) return {run: n, ...j};
  }
  return null;
}
const ACTIONS = {
  start: {label: '采集 + AI 选题', args: ['run']},
  recollect: {label: '重新采集来源', args: ['recollect']},
  reselect: {label: '重新让 AI 选题', args: ['run', '--from', 'select', '--stop-after', 'select']},
  'after-select': {label: '读原文 + 写稿', args: ['run', '--from', 'enrich']},
  'after-write': {label: '配音', args: ['run', '--from', 'voice']},
  revoice: {label: '重新配音', args: ['run', '--from', 'voice', '--stop-after', 'voice']},
  stills: {label: '生成画面预览', args: ['run', '--stills']},
  'after-voice': {label: '渲染视频', args: ['run', '--from', 'render']},
  export: {label: '导出素材包', args: ['run', '--from', 'export']},
};
async function startJob(name, action, opt = {}) {
  const a = ACTIONS[action]; if (!a) throw httpError(400, '未知操作');
  const running = await anyRunningJob(); if (running) throw httpError(409, `「${running.run}」正在${running.label}，等它结束再操作`);
  const dir = path.join(RUNS, name);
  const args = ['src/main.mjs', ...a.args, '--date', name.slice(0, 10), '--run', name];
  if (action === 'recollect') { const ids = (opt.sources || []).filter(x => /^[\w-]+$/.test(x)); if (!ids.length) throw httpError(400, '没有选要重试的来源'); args.push('--sources', ids.join(',')); }
  if (action === 'export' && !finalVideo(dir)) throw httpError(409, '还没有成片，先渲染视频');
  if (['after-write', 'revoice'].includes(action)) await fsp.rm(path.join(dir, 'publish-edit.json'), {force: true}); // 时间轴会变，简介按新配音重新生成
  const logFile = path.join(dir, 'workbench-job.log');
  const fd = fs.openSync(logFile, 'w');
  const child = spawn(process.execPath, args, {cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', fd, fd]});
  fs.closeSync(fd);
  const job = {action, label: a.label, pid: child.pid, running: true, startedAt: new Date().toISOString(), args: args.slice(1)};
  await writeJson(jobFile(dir), job);
  child.on('exit', async code => { job.running = false; job.exitCode = code; job.endedAt = new Date().toISOString(); await writeJson(jobFile(dir), job).catch(() => {}); });
  child.unref();
  return job;
}

// ---------- 总览 ----------
async function listRuns() {
  const out = [];
  for (const n of fs.readdirSync(RUNS).filter(n => RUN_RE.test(n)).sort().reverse()) {
    const dir = path.join(RUNS, n);
    const st = await readJson(path.join(dir, 'status.json'), {});
    out.push({name: n, stage: st.stage || '', message: st.message || '', exported: exists(path.join(dir, 'exported.json'))});
  }
  return out;
}
async function overview(name) {
  const dir = runDir(name);
  const f = n => exists(path.join(dir, n));
  const video = finalVideo(dir);
  const t = n => mtime(path.join(dir, n));
  const vt = video ? t(video) : 0, written = t('stories-written.json'), timeline = t('timeline.json');
  return {
    name, date: name.slice(0, 10), workflow: await getWorkflow(),
    status: await readJson(path.join(dir, 'status.json'), {}),
    job: await currentJob(dir),
    has: {candidates: f('candidates.json'), report: f('collect-report.json'), selected: f('stories-selected.json'), written: f('stories-written.json'), voice: f('timeline.json') && f('narration.wav'), stills: f('stills'), video: !!video, cover: f('cover.jpg'), publish: f('publish.json')},
    video, coverTime: t('cover.jpg'), videoTime: vt,
    stale: {
      written: !!(written && t('stories-selected.json') > written + 1000), // 选题改了，稿子还是旧的
      voice: !!(timeline && written > timeline + 1000),                    // 稿子改了，配音还是旧的
      video: !!(vt && timeline > vt + 1000),                               // 配音改了，视频还是旧的
    },
    package: exists(path.join(dir, 'exported.json')) ? path.join(dir, 'package') : null,
    log: (await readLines(path.join(dir, 'run.log'))).slice(-40).join('\n'),
    jobLog: (await readLines(path.join(dir, 'workbench-job.log'))).slice(-15).join('\n'),
  };
}

// ---------- 模块一：信息采集 ----------
async function allSources() { return (await readJson(path.join(ROOT, 'sources.json'))).sources; }
async function getSources() { return (await allSources()).map(s => ({id: s.id, name: s.name, kind: s.kind, lang: s.lang, enabled: s.enabled !== false})); }
async function getCollect(name) {
  const dir = runDir(name);
  const rep = await readJson(path.join(dir, 'collect-report.json'), {report: [], warnings: []});
  const names = new Map((await allSources()).map(s => [s.id, s]));
  const items = await readJson(path.join(dir, 'candidates.json'), []);
  const perSource = {}; for (const i of items) for (const s of i.seenIn || [i.source]) perSource[s] = (perSource[s] || 0) + 1;
  const chosen = await readJson(path.join(dir, 'sources-chosen.json'), null);
  return {
    total: items.length, chosen, manual: items.filter(i => i.source === 'manual').map(slimItem),
    report: rep.report.map(r => ({...r, name: names.get(r.id)?.name || r.id, kind: names.get(r.id)?.kind || '', inPool: perSource[r.id] || 0})).sort((a, b) => (a.ok - b.ok) || (b.kept || 0) - (a.kept || 0)),
    warnings: rep.warnings || [],
  };
}
// tr = 这期的翻译表（translations.json），有中文就带上 titleZh / summaryZh，工作台显示中英对照
const slimItem = (i, tr) => ({id: i.id, title: i.title, url: i.url, sourceName: i.sourceName, kind: i.kind, date: i.date, summary: summaryText(i.summary), ...(tr && typeof tr === 'object' ? zhOf(tr, i) : {})});
function heatLine(h = {}) {
  const p = [];
  if (h.xLikes) p.push(`X ${h.xLikes}赞`); if (h.hnPoints) p.push(`HN ${h.hnPoints}分`); if (h.redditScore) p.push(`Reddit ${h.redditScore}赞`);
  if (h.ghStarsWeek) p.push(`GitHub 本周+${h.ghStarsWeek}星`); if (h.ghTrendingDays) p.push(`上每日热榜${h.ghTrendingDays}天`);
  if (h.ghStarsToday) p.push(`GitHub ${h.ghTrendingDays ? '单日最多' : ''}+${h.ghStarsToday}星`); if (h.ghStars && h.noAge) p.push(`总${h.ghStars}星`); if (h.hfTrendingRank) p.push(`HF热门#${h.hfTrendingRank}`); if (h.weiboRank) p.push(`微博热搜#${h.weiboRank}`);
  if (h.media) p.push(`媒体${h.media}家`); if (h.official) p.push('官方');
  if (h.sources) p.push(`${h.sources.length}个来源`); if (h.hoursAgo != null && !h.noAge) p.push(`${h.hoursAgo}小时前`);
  return p.join(' · ');
}
async function groupsOf(dir) {
  const items = await readJson(path.join(dir, 'candidates.json'));
  const col = getColumn(loadConfig(), {run: path.basename(dir)});
  if (col.mode === 'github') { // GitHub 板块：按仓库归并，最近几周导出过的项目不列出；热度用采集时算好的（含 HN 讨论）
    const saved = new Map((await readJson(path.join(dir, 'clusters.json'), [])).filter(c => c.repo).map(c => [c.repo, c.heat]));
    const {candidates} = buildGithubCandidates(items, {exclude: recentRepos(col, path.basename(dir).slice(0, 10), {weeks: col.dedupeWeeks || 8}), max: 2000, quiet: true});
    for (const c of candidates) if (saved.has(c.repo)) c.heat = saved.get(c.repo);
    return candidates.sort((a, b) => b.heat.score - a.heat.score);
  }
  return buildCandidates(items, {max: 2000, nonAiMax: col.nonAI ? 2000 : 0, now: mtime(path.join(dir, 'candidates.json')) || Date.now()}).candidates;
}
async function getSelection(name) {
  const dir = runDir(name);
  const stories = await readJson(path.join(dir, 'stories-selected.json'), []);
  const groups = await groupsOf(dir);
  const chosen = new Set(stories.flatMap(s => s.items.map(i => i.id)));
  const notes = (await readJson(path.join(dir, 'selection.json'), {})).notes || '';
  const tr = await loadTranslations(dir), slim = i => slimItem(i, tr);
  return {
    chapters: chaptersOf(name), column: getColumn(loadConfig(), {run: name}).name, notes, translated: Object.keys(tr).length,
    stories: stories.map(s => ({id: s.id, chapter: s.chapter, workingTitle: s.workingTitle, importance: s.importance, reason: s.reason, heat: heatLine(s.heat), items: s.items.map(slim)})),
    groups: groups.map(g => ({key: g.key, score: g.heat.score, heat: heatLine(g.heat), chosen: g.items.some(i => chosen.has(i.id)), items: g.items.map(slim)})),
  };
}
async function saveSelection(name, body) {
  const dir = runDir(name);
  if (!Array.isArray(body.stories) || !body.stories.length) throw httpError(400, '至少要留一条新闻');
  const items = new Map((await readJson(path.join(dir, 'candidates.json'))).map(i => [i.id, i]));
  const old = await readJson(path.join(dir, 'stories-selected.json'), []);
  const oldHeat = new Map(old.flatMap(s => s.items.map(i => [i.id, s.heat])));
  const oldNonAI = new Map(old.filter(s => s.nonAI).flatMap(s => s.items.map(i => [i.id, s.aiAngle || '']))); // 非 AI 科技大事：写稿时要按那条的写法（含和 AI 的关系）
  const groups = await groupsOf(dir);
  const groupHeat = new Map(groups.flatMap(g => g.items.map(i => [i.id, g.heat])));
  const groupRepo = new Map(groups.filter(g => g.repo).flatMap(g => g.items.map(i => [i.id, g.repo]))); // GitHub 板块：记下是哪个仓库（防重复用）
  const used = new Set();
  const chapters = chaptersOf(name);
  const out = body.stories.map(s => {
    const its = (s.itemIds || []).filter(id => items.has(id) && !used.has(id)).map(id => (used.add(id), items.get(id)));
    if (!its.length) throw httpError(400, `「${s.workingTitle || '某条'}」没有对应的原始新闻`);
    const chapter = chapters.includes(s.chapter) ? s.chapter : chapters[chapters.length - 1];
    const repo = groupRepo.get(its[0].id);
    return {id: '', ...(repo ? {repo} : {}), chapter, workingTitle: clean(s.workingTitle) || its[0].title, importance: Math.max(1, Math.min(10, Number(s.importance) || 5)), reason: clean(s.reason) || '手动选入', ...(its.every(i => i.nonAI) || oldNonAI.has(its[0].id) ? {nonAI: true, aiAngle: oldNonAI.get(its[0].id) || ''} : {}), items: its, heat: oldHeat.get(its[0].id) || groupHeat.get(its[0].id) || {score: 0, sources: []}};
  });
  if (chapters.length > 1) out.sort((a, b) => chapters.indexOf(a.chapter) - chapters.indexOf(b.chapter)); // 和自动选题一样按栏目排（只有一个栏目时保持你排的顺序）
  out.forEach((s, i) => s.id = 's' + (i + 1));
  await backupOnce(dir, 'stories-selected.json');
  await writeJson(path.join(dir, 'stories-selected.json'), out);
  return {ok: true, count: out.length};
}
// 自己找到的新闻：粘贴链接，读出标题和摘要，加进候选
async function addManualItem(name, body) {
  const dir = runDir(name);
  let url; try { url = new URL(String(body.url || '').trim()); } catch { throw httpError(400, '链接格式不对'); }
  if (!/^https?:$/.test(url.protocol)) throw httpError(400, '只支持 http/https 链接');
  const file = path.join(dir, 'candidates.json');
  const items = await readJson(file, []);
  const dup = items.find(i => i.url === url.href); if (dup) return {item: slimItem(dup), existed: true};
  let a = {};
  try { const r = await fetchText(url.href, {timeoutMs: 18000, retries: 0}); a = extractArticle(r.text, r.url); } catch (e) { if (!clean(body.title)) throw httpError(400, '打不开这个链接（' + e.message.slice(0, 80) + '），可以手动填标题再加'); }
  const title = clean(body.title) || clean(a.title); if (!title) throw httpError(400, '读不到标题，请手动填一个');
  const n = Math.max(0, ...items.filter(i => /^m\d+$/.test(i.id)).map(i => +i.id.slice(1))) + 1;
  const item = {id: 'm' + n, title, url: url.href, summary: clean(body.note) || clean(a.description) || String(a.text || '').slice(0, 300), date: a.published || new Date().toISOString(), image: a.image || null,
    source: 'manual', sourceName: clean(a.siteName) || url.hostname.replace(/^www\./, ''), kind: 'media', lang: /[一-龥]/.test(title) ? 'zh' : 'en', seenIn: ['manual']};
  items.push(item); await writeJson(file, items);
  if (item.lang !== 'zh') translateRun(dir); // 后台翻成中文，刷新后显示；失败也不影响
  return {item: slimItem(item)};
}

// ---------- 模块二：视频编辑 ----------
async function getWritten(name) {
  const dir = runDir(name);
  const stories = await readJson(path.join(dir, 'stories-written.json'), []);
  const written = new Set(stories.map(s => s.id));
  const skipped = (await readJson(path.join(dir, 'stories-selected.json'), [])).filter(s => !written.has(s.id)).map(s => s.workingTitle);
  return {
    icons: ICON_NAMES, chapters: chaptersOf(name), skipped,
    stories: stories.map(s => ({
      id: s.id, chapter: s.chapter, title: s.title, short: s.short, sourceLine: s.sourceLine, coverTitle: s.coverTitle, tags: s.tags || [], tweetZh: s.tweetZh || '',
      hasTweet: !!s.tweet, tweet: s.tweet ? {name: s.tweet.name, text: s.tweet.text} : null,
      cards: s.cards, narration: s.narration,
      sources: (s.sources || []).map(x => ({title: x.title, url: x.url, site: x.site, summary: String(x.summary || x.article?.description || '').slice(0, 300), image: /logo|icon|avatar|favicon/i.test(x.article?.image || '') ? null : x.article?.image || null})),
      media: (s.media || []).map(m => ({src: rel(dir, m.file), w: m.w, h: m.h, url: m.url, kind: m.kind, caption: m.caption || '', sentence: m.sentence ?? -1, ai: m.ai || null})).filter(m => !m.src.startsWith('..')),
      rejected: (s.mediaRejected || []).filter(m => exists(m.file)).map(m => ({src: rel(dir, m.file), w: m.w, h: m.h, url: m.url, kind: m.kind, caption: m.caption || '', sentence: m.sentence ?? -1, ai: m.ai || null})).filter(m => !m.src.startsWith('..')),
      imageCheck: s.imageCheck || null,
    })),
  };
}
async function saveWritten(name, body) {
  const dir = runDir(name);
  const file = path.join(dir, 'stories-written.json');
  const byId = new Map((await readJson(file)).map(s => [s.id, s]));
  if (!Array.isArray(body.stories) || !body.stories.length) throw httpError(400, '至少要留一条新闻');
  const out = body.stories.map(e => {
    const s = byId.get(e.id); if (!s) throw httpError(400, '找不到条目 ' + e.id);
    const cards = (e.cards || []).map(c => ({icon: ICON_NAMES.includes(c.icon) ? c.icon : 'sparkles', heading: clean(c.heading), body: clean(c.body)})).filter(c => c.heading || c.body).slice(0, 6);
    if (!cards.length) throw httpError(400, `「${s.title}」至少要有一张卡片`);
    const narration = (e.narration || []).map(n => ({text: clean(n.text), card: Number.isInteger(n.card) && n.card >= 0 && n.card < cards.length ? n.card : -1})).filter(n => n.text);
    if (!narration.length) throw httpError(400, `「${s.title}」口播稿不能为空`);
    let media = s.media;
    if (Array.isArray(e.media)) media = e.media.map(m => {
      const f = path.resolve(dir, String(m.src || '')); if (!f.startsWith(dir + path.sep) || !exists(f)) throw httpError(400, '配图文件不存在：' + m.src);
      // 保留 AI 看图写的图注、对应句子（加回的图从 mediaRejected 里找）；手动加的图没有
      const old = [...(s.media || []), ...(s.mediaRejected || [])].find(x => x.file === f);
      return {file: f, w: Number(m.w) || 0, h: Number(m.h) || 0, kind: m.kind === 'screenshot' ? 'screenshot' : 'image', url: String(m.url || ''), ...(old?.caption ? {caption: old.caption} : {}), ...(Number.isInteger(old?.sentence) ? {sentence: old.sentence} : {}), ...(old?.ai ? {ai: old.ai} : {})};
    }).slice(0, 4);
    const used = new Set(media.map(m => m.file));
    const mediaRejected = (s.mediaRejected || []).filter(m => !used.has(m.file));
    return {...s, title: clean(e.title) || s.title, short: clean(e.short), sourceLine: clean(e.sourceLine), coverTitle: clean(e.coverTitle), tweetZh: clean(e.tweetZh),
      tags: (e.tags || []).map(clean).filter(Boolean).slice(0, 3), cards, narration, media, mediaRejected};
  });
  await backupOnce(dir, 'stories-written.json');
  await writeJson(file, out);
  return {ok: true, count: out.length};
}
// 换图：上传自己的图片，或者从原文里的图片地址下载
async function addImage(name, body) {
  const dir = runDir(name);
  let buf, url = '';
  if (body.data) { const m = /^data:image\/[\w+.-]+;base64,(.+)$/.exec(body.data); if (!m) throw httpError(400, '图片格式不对'); buf = Buffer.from(m[1], 'base64'); }
  else if (body.url) {
    url = String(body.url); if (!/^https?:\/\//.test(url)) throw httpError(400, '图片地址不对');
    const r = await fetch(url, {headers: {'user-agent': 'Mozilla/5.0'}, signal: AbortSignal.timeout(20000)}); if (!r.ok) throw httpError(400, '下载图片失败：' + r.status);
    buf = Buffer.from(await r.arrayBuffer());
  } else throw httpError(400, '没有图片');
  if (buf.length > 15 * 1024 * 1024) throw httpError(400, '图片太大（超过 15MB）');
  const [w, h, ext] = imageSize(buf) || [];
  if (!w || !h || !['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) throw httpError(400, '认不出这张图（支持 jpg / png / webp）');
  if (w < 320 || h < 180) throw httpError(400, `图片太小（${w}×${h}），画面上会糊`);
  const sid = String(body.storyId || 'x').replace(/[^\w-]/g, '');
  const file = path.join(dir, 'media', `${sid}-手动${Date.now().toString(36)}.${ext === 'jpeg' ? 'jpg' : ext}`);
  await fsp.mkdir(path.dirname(file), {recursive: true}); await fsp.writeFile(file, buf);
  return {src: rel(dir, file), w, h, kind: 'image', url};
}
async function getVoice(name) {
  const dir = runDir(name);
  const tl = await readJson(path.join(dir, 'timeline.json'), null);
  const stories = new Map((await readJson(path.join(dir, 'stories-written.json'), [])).map(s => [s.id, s]));
  const revoice = await readJson(path.join(dir, 'audio', 'revoice.json'), {});
  // 配音质检：每段最近一次合成里「重试后仍不理想」的句子
  const warn = {}, pending = {};
  for (const l of await readLines(path.join(dir, 'run.log'))) {
    let m = /\bWARN (\w+)#(\d+) (.*)$/.exec(l); if (m) { (pending[m[1]] ||= {})[m[2]] = m[3]; continue; }
    m = /\bOK (\w+)\s/.exec(l); if (m) { warn[m[1]] = pending[m[1]] || {}; delete pending[m[1]]; }
  }
  const audioDir = path.join(dir, 'audio');
  const segs = [];
  for (const seg of tl?.segments || []) {
    const file = ['wav', 'mp3'].map(e => path.join(audioDir, `${seg.id}.${e}`)).find(exists);
    const meta = file ? await readJson(file + '.json', {words: []}) : {words: []};
    segs.push({id: seg.id, type: seg.type, title: seg.type === 'intro' ? '开场' : seg.type === 'outro' ? '结尾' : (stories.get(seg.id)?.title || seg.title), start: seg.start,
      audio: file ? rel(dir, file) : null, audioTime: file ? mtime(file) : 0,
      sentences: meta.words.map((w, k) => ({k, text: w.text, t0: w.t0, t1: w.t1, warn: warn[seg.id]?.[k] || null, retakes: revoice[seg.id]?.[k] || 0}))});
  }
  return {segments: segs, duration: tl?.duration || 0, provider: loadConfig().tts?.provider || 'edge', narrationTime: mtime(path.join(dir, 'narration.wav'))};
}
async function markRevoice(name, body) {
  const dir = runDir(name);
  const file = path.join(dir, 'audio', 'revoice.json');
  const rv = await readJson(file, {});
  let n = 0;
  for (const [seg, ks] of Object.entries(body.marks || {})) for (const k of ks) { if (!/^\w+$/.test(seg) || !Number.isInteger(k)) continue; (rv[seg] ||= {})[k] = (rv[seg][k] || 0) + 1; n++; }
  if (!n) throw httpError(400, '没有勾选要重念的句子');
  if (await anyRunningJob()) throw httpError(409, '还有步骤在后台运行，等它结束再重念');
  await writeJson(file, rv);
  return startJob(name, 'revoice');
}
async function getStills(name) {
  const dir = runDir(name);
  const sd = path.join(dir, 'stills');
  const tl = await readJson(path.join(dir, 'timeline.json'), {segments: []});
  const files = exists(sd) ? fs.readdirSync(sd).filter(f => f.endsWith('.png')) : [];
  const frames = files.map(f => { const t = Number(f.replace(/^frame-/, '').replace('.png', '').replace('_', '.')); const seg = tl.segments.find(s => t >= s.start && t < s.end); return {src: 'stills/' + f, t, title: seg ? (seg.type === 'intro' ? '开场' : seg.type === 'outro' ? '结尾' : seg.title) : ''}; }).sort((a, b) => a.t - b.t);
  return {frames, time: mtime(sd), cover: exists(path.join(dir, 'cover.jpg')), coverTime: mtime(path.join(dir, 'cover.jpg')), stale: frames.length > 0 && mtime(path.join(dir, 'timeline.json')) > mtime(sd) + 1000};
}

// ---------- 模块三：导出（只改标题、简介、标签；没有任何投稿代码）----------
async function getPublish(name) {
  const dir = runDir(name);
  const auto = await readJson(path.join(dir, 'publish-auto.json'), null) || await readJson(path.join(dir, 'publish.json'), null);
  const edit = await readJson(path.join(dir, 'publish-edit.json'), null);
  const current = auto ? {...auto, ...edit} : null;
  return {auto, edit, current, baseTags: loadConfig().metadata?.baseTags || []};
}
async function savePublish(name, body) {
  const dir = runDir(name);
  if (body.reset) {
    await fsp.rm(path.join(dir, 'publish-edit.json'), {force: true});
    const auto = await readJson(path.join(dir, 'publish-auto.json'), null);
    if (auto) await writeJson(path.join(dir, 'publish.json'), auto);
    return {ok: true};
  }
  const title = clean(body.title), desc = String(body.desc || '').replace(/\r\n/g, '\n').trim();
  const tags = [...new Set((body.tags || []).map(clean).filter(Boolean))];
  if (!title) throw httpError(400, '标题不能为空');
  if (title.length > 80) throw httpError(400, `标题 ${title.length} 字，最多 80 字`);
  if (desc.length > 2000) throw httpError(400, `简介 ${desc.length} 字，最多 2000 字`);
  if (!tags.length || tags.length > 10) throw httpError(400, '标签要 1–10 个');
  const long = tags.find(t => t.length > 20); if (long) throw httpError(400, `标签「${long}」超过 20 字`);
  await writeJson(path.join(dir, 'publish-edit.json'), {title, desc, tags, editedAt: new Date().toISOString()});
  const pub = await readJson(path.join(dir, 'publish.json'), null);
  if (pub) await writeJson(path.join(dir, 'publish.json'), {...pub, title, desc, tags});
  return {ok: true};
}

// ---------- HTTP ----------
function send(res, code, value) { res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(value)); }
async function body(req) { let t = ''; for await (const c of req) { t += c; if (t.length > 25e6) throw httpError(413, '内容太大'); } return t ? JSON.parse(t) : {}; }
async function streamFile(req, res, file) {
  const type = TYPES[path.extname(file).toLowerCase()]; if (!type) throw httpError(404, '不支持预览这种文件');
  const size = (await fsp.stat(file)).size;
  let start = 0, end = size - 1; const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m) { start = m[1] ? +m[1] : size - +m[2]; end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1; }
  res.writeHead(m ? 206 : 200, {'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', ...(m ? {'Content-Range': `bytes ${start}-${end}/${size}`} : {})});
  fs.createReadStream(file, {start, end}).on('error', () => res.destroy()).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw httpError(403, '工作台只允许本机访问');
    if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `http://${host}`) throw httpError(403, '拒绝其他网站的操作');
    const url = new URL(req.url, `http://${host}`);
    const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const M = req.method;
    if (!seg.length) { res.writeHead(200, {'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store'}); fs.createReadStream(PAGE).pipe(res); return; }
    if (seg[0] === 'files') { // /files/<期>/<文件路径>
      const dir = runDir(seg[1]); const file = path.resolve(dir, ...seg.slice(2));
      if (!file.startsWith(dir + path.sep)) throw httpError(403, '路径不对');
      return await streamFile(req, res, file);
    }
    if (seg[0] !== 'api') throw httpError(404, '页面不存在');
    const [, what, name, sub] = seg;
    if (what === 'workflow') return send(res, 200, M === 'PUT' ? await saveWorkflow(await body(req)) : await getWorkflow());
    if (what === 'sources' && M === 'GET') return send(res, 200, {sources: await getSources(), columns: columnList(loadConfig()).map(c => ({id: c.id, name: c.name, runSuffix: c.runSuffix, sources: c.sources || null}))});
    if (what === 'runs' && !name && M === 'GET') return send(res, 200, {runs: await listRuns(), today: dateParts().iso});
    if (what === 'runs' && !name && M === 'POST') { // 新开一期：按勾选的来源采集，AI 先选一版
      const b = await body(req); const col = getColumn(loadConfig(), {id: b.column}); const n = b.name || runNameFor(col, dateParts().iso);
      if (!RUN_RE.test(n)) throw httpError(400, '期数名称不对');
      const dir = path.join(RUNS, n);
      if (exists(path.join(dir, 'candidates.json'))) throw httpError(409, `「${n}」已经采集过了，直接在下拉框里选它；想重新采集请换个名字`);
      await fsp.mkdir(dir, {recursive: true});
      await writeJson(path.join(dir, 'column.json'), {id: col.id, name: col.name}); // 记下这一期属于哪个板块
      if (Array.isArray(b.sources)) { if (!b.sources.length) throw httpError(400, '至少选一个来源'); await writeJson(path.join(dir, 'sources-chosen.json'), b.sources); }
      return send(res, 200, await startJob(n, 'start'));
    }
    if (what !== 'runs' || !name) throw httpError(404, '接口不存在');
    if (!sub && M === 'GET') return send(res, 200, await overview(name));
    if (sub === 'collect' && M === 'GET') return send(res, 200, await getCollect(name));
    if (sub === 'selection') return send(res, 200, M === 'PUT' ? await saveSelection(name, await body(req)) : await getSelection(name));
    if (sub === 'manual-item' && M === 'POST') return send(res, 200, await addManualItem(name, await body(req)));
    if (sub === 'translate' && M === 'POST') return send(res, 200, await translateRun(runDir(name))); // 「补翻译」：旧期或没翻完的候选
    if (sub === 'written') return send(res, 200, M === 'PUT' ? await saveWritten(name, await body(req)) : await getWritten(name));
    if (sub === 'image' && M === 'POST') return send(res, 200, await addImage(name, await body(req)));
    if (sub === 'voice' && M === 'GET') return send(res, 200, await getVoice(name));
    if (sub === 'revoice' && M === 'POST') return send(res, 200, await markRevoice(name, await body(req)));
    if (sub === 'stills' && M === 'GET') return send(res, 200, await getStills(name));
    if (sub === 'publish') return send(res, 200, M === 'PUT' ? await savePublish(name, await body(req)) : await getPublish(name));
    if (sub === 'action' && M === 'POST') { runDir(name); const b = await body(req); return send(res, 200, await startJob(name, b.action, b)); }
    throw httpError(404, '接口不存在');
  } catch (e) {
    if (res.headersSent) { res.destroy(); return; }
    send(res, e.status || (e.code === 'ENOENT' ? 404 : 500), {error: e.code === 'ENOENT' ? '文件不存在（这一步可能还没做）' : e.message});
  }
});
const URL_ = `http://127.0.0.1:${PORT}/`;
const openBrowser = () => { if (argv.includes('--open')) spawn('cmd', ['/c', 'start', '', URL_], {detached: true, stdio: 'ignore', windowsHide: true}).unref(); };
server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.log(`工作台已经开着了，直接打开 ${URL_}`); openBrowser(); setTimeout(() => process.exit(0), 500); return; }
  console.error(e.message); process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`手动工作台已启动：${URL_}`);
  console.log('这个窗口请保持打开；关掉它网页就打不开了（正在后台跑的步骤不受影响）。');
  openBrowser();
});
