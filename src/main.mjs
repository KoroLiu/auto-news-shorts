// Daily AI news video: collect → select → read articles → write → voice-over/subtitles → render → covers → export kit
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ROOT, log, setLogFile, loadConfig, readJson, writeJson, exists, dateParts, findFfmpeg, mmss, ffprobeDuration} from './util.mjs';
import {collect, normUrl, fetchTrending} from './collect.mjs';
import {saveDailyTrending, recentRepos, buildGithubCandidates, addHnHeat} from './github.mjs';
import {buildCandidates, selectStories} from './rank.mjs';
import {enrich} from './enrich.mjs';
import {writeStories} from './write.mjs';
import {buildEpisode, publishInfo} from './timeline.mjs';
import {renderVideo, renderCover, muxAudio, renderStills} from './render/render.mjs';
import {portraitCoverData, hookCoverData} from './render/logos.mjs';
import {prepareRemotion, renderRemotion} from './render/remotion.mjs';
import {synthesize} from './tts/tts.mjs';
import {getColumn, runNameFor, columnSources, recentColumnTitles, previousEpisodes, episodeUrls, urlKey, DEFAULT_COLUMN} from './columns.mjs';
import {checkImages} from './imagecheck.mjs';
import {translateRun} from './translate.mjs';
import {exportPackage} from './export.mjs';
import {checkLlmConfig} from './llm.mjs';

const STAGES = ['collect', 'select', 'enrich', 'write', 'voice', 'render', 'export'];

function parseArgs(argv) {
  const a = {cmd: 'run'};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--date') a.date = argv[++i];
    else if (k === '--from') a.from = argv[++i];
    else if (k === '--preview') a.preview = Number(argv[++i] || 60);
    else if (k === '--stills') a.stills = true;
    else if (k === '--stop-after') a.stopAfter = argv[++i];
    else if (k === '--run') a.run = argv[++i];
    else if (k === '--auto') a.auto = true;
    else if (k === '--sources') a.sources = argv[++i];
    else if (k === '--column') a.column = argv[++i];
    else if (!k.startsWith('--')) a.cmd = k;
  }
  return a;
}

// 流程开关（工作台里可以改）：三大模块做完后，是直接往下走，还是停下等人审核
const WORKFLOW_FILE = path.join(ROOT, 'workflow.json');
const loadWorkflow = () => ({collectReview: true, editReview: true, ...JSON.parse(fs.existsSync(WORKFLOW_FILE) ? fs.readFileSync(WORKFLOW_FILE, 'utf8').replace(/^\uFEFF/, '') : '{}')});

async function status(runDir, s) { await writeJson(path.join(runDir, 'status.json'), {...s, updatedAt: new Date().toISOString()}); }

// 这一期属于哪个板块、文件夹在哪：工作台会传 --run；一键生成只给日期（和 --column），按「日期-板块」找，
// If not found, fall back to an old folder without a suffix (runs/<date>).
function resolveRun(args, dp, cfg = loadConfig()) {
  const col = getColumn(cfg, {id: args.column, run: args.run});
  if (args.run) return {col, runDir: path.join(ROOT, 'runs', args.run)};
  const named = path.join(ROOT, 'runs', runNameFor(col, dp.iso)), legacy = path.join(ROOT, 'runs', dp.iso);
  return {col, runDir: !exists(named) && col.id === DEFAULT_COLUMN && exists(legacy) ? legacy : named};
}

// 晚报（sinceLastEpisode）：只采上一期之后的新闻。上一期采集时间按它的 candidates.json 算，多往前留 1 小时，
// 免得刚好卡在边上的漏掉（重复的由下面 dropPrevious 和选题时的「已播列表」挡住）。
function windowFor(col, cfg, dp, runDir) {
  const max = col.windowHours || cfg.video?.windowHours || 30;
  if (!col.sinceLastEpisode) return max;
  const prev = previousEpisodes(col, dp.iso, {current: path.basename(runDir), episodes: 1})[0];
  if (!prev?.collectedAt) return max;
  const hours = Math.max(6, (Date.now() - prev.collectedAt) / 3600000 + 1);
  if (hours >= max) return max;
  log(`只采上一期（${prev.name}，${new Date(prev.collectedAt).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false})} 北京时间采集）之后的新闻：最近 ${hours.toFixed(1)} 小时`);
  return hours;
}

// 上一期讲过的新闻硬性去掉（不靠 AI）：候选事件里只要有一条网址是上一期用过的，整个事件不要。去掉了哪些写在 dedupe-prev.json。
async function dropPrevious(candidates, col, dp, runDir) {
  const prev = previousEpisodes(col, dp.iso, {current: path.basename(runDir), episodes: 1})[0];
  if (!prev) return candidates;
  const used = episodeUrls(prev);
  const removed = [], kept = candidates.filter(c => {
    const hit = c.items.find(i => used.has(urlKey(i.url || '')));
    if (hit) removed.push({key: c.key, title: c.items[0]?.title, url: hit.url});
    return !hit;
  });
  await writeJson(path.join(runDir, 'dedupe-prev.json'), {previous: prev.name, removed});
  log(`上一期（${prev.name}）讲过的 ${removed.length} 个事件已从候选里去掉`);
  return kept;
}

async function runPipeline(args) {
  const cfg = loadConfig();
  const dp = args.date ? dateParts(new Date(args.date + 'T08:00:00+08:00')) : dateParts();
  const {col, runDir} = resolveRun(args, dp, cfg);
  cfg.column = col; // 板块：来源、选题规则、条数、标题、画面名字
  await fsp.mkdir(path.join(runDir, 'llm'), {recursive: true});
  setLogFile(path.join(runDir, 'run.log'));
  const fromIdx = args.from ? STAGES.indexOf(args.from) : -1;
  let forced = false; // once a stage re-runs, everything after it must re-run too
  const ran = new Set(); // stages actually (re)done in this run
  const need = (stage, file) => { const r = forced || (fromIdx >= 0 && STAGES.indexOf(stage) >= fromIdx) || !exists(path.join(runDir, file)); if (r) { forced = true; ran.add(stage); } return r; };
  const llmErr = checkLlmConfig(cfg);
  if (llmErr) throw new Error(llmErr);
  const {ffmpeg, ffprobe} = findFfmpeg(cfg);
  // 做完某一步后停下，等人在工作台里审核（--auto 时一路跑完；--stop-after 强制在某步停）
  const wf = loadWorkflow();
  const reviewOn = {select: wf.collectReview, write: wf.editReview, voice: wf.editReview};
  const pause = async (stage, message) => {
    if (args.stopAfter !== stage && (args.auto || !ran.has(stage) || !reviewOn[stage])) return false;
    await status(runDir, {stage: 'review-' + stage, message}); log(message + '（运行 npm run workbench 打开工作台）'); return true;
  };
  log(`==== ${dp.iso} 开始制作「${col.name}」（目录 ${runDir}）====`);
  const lock = path.join(runDir, '.lock');
  if (exists(lock) && Date.now() - fs.statSync(lock).mtimeMs < 3 * 3600 * 1000) throw new Error('今天的任务正在运行中（如确认没有运行，删除 runs/日期/.lock 后重试）');
  fs.writeFileSync(lock, String(process.pid));
  try {
    // 1. collect
    let items;
    if (need('collect', 'candidates.json')) {
      await status(runDir, {stage: 'collect', message: '正在采集资讯'});
      if (dp.iso === dateParts().iso) await archiveGithubDaily(dp.iso); // 不管哪个板块，都顺便存一份当天的 GitHub 每日热榜，给周日的 GitHub 板块用
      const src = await readJson(path.join(ROOT, 'sources.json'));
      const chosen = await readJson(path.join(runDir, 'sources-chosen.json'), null); // 工作台里勾选的来源
      const colSources = columnSources(col, src.sources); // 只用这个板块的来源；X 去掉这个板块不看的账号
      ({items} = await collect({sources: chosen ? colSources.map(s => ({...s, enabled: chosen.includes(s.id)})) : colSources, windowHours: windowFor(col, cfg, dp, runDir), outDir: runDir, chromePath: cfg.render?.chromePath, nonAI: !!col.nonAI}));
    } else items = await readJson(path.join(runDir, 'candidates.json'));
    // 候选的中文翻译（工作台中英对照用）：和选题同时跑，只翻没翻过的；失败只显示英文，不影响后面
    const trJob = cfg.translate?.enabled === false ? null : translateRun(runDir);

    // 2. select
    let stories;
    if (need('select', 'stories-selected.json')) {
      await status(runDir, {stage: 'select', message: '正在挑选热点'});
      let candidates, digests;
      if (col.mode === 'github') { // 每周 GitHub 项目：按仓库归并，最近几周导出过的项目直接去掉（硬性，不靠 AI），再查 HN 讨论
        const exclude = recentRepos(col, dp.iso, {weeks: col.dedupeWeeks || 8});
        let skipped; ({candidates, digests, skipped} = buildGithubCandidates(items, {exclude}));
        await addHnHeat(candidates);
        await writeJson(path.join(runDir, 'github-dedupe.json'), {weeks: col.dedupeWeeks || 8, recent: Object.fromEntries(exclude), removed: skipped});
      } else {
        ({candidates, digests} = buildCandidates(items, {nonAiMax: col.nonAI?.candidates || 0}));
        if (col.sinceLastEpisode) candidates = await dropPrevious(candidates, col, dp, runDir);
      }
      await writeJson(path.join(runDir, 'clusters.json'), candidates.map(c => ({key: c.key, ...(c.repo ? {repo: c.repo} : {}), heat: c.heat, titles: c.items.map(i => `[${i.sourceName}] ${i.title}`)})));
      ({stories} = await selectStories({candidates, digests, cfg, date: `${dp.iso}（星期${dp.weekday}）`, workDir: path.join(runDir, 'llm'), col, history: recentColumnTitles(col, dp.iso, {current: path.basename(runDir)})}));
      await writeJson(path.join(runDir, 'stories-selected.json'), stories);
    } else stories = await readJson(path.join(runDir, 'stories-selected.json'));
    if (!stories.length) throw new Error('没有选出任何新闻');
    await trJob;
    // Political-content gate (politics.mjs, config.select.politicsFilter): flagged or unsure stories stop at topic review, even with --auto.
    // The same set only stops once — after a human removes them or confirms in the workbench, the run continues.
    const pol = cfg.select?.politicsFilter === false ? [] : stories.filter((s) => s.politics?.flag === 'yes' || s.politics?.flag === 'unsure');
    if (pol.length) {
      const seenFile = path.join(runDir, 'politics-checked.json');
      const ids = pol.map((s) => `${s.id} ${s.workingTitle}`);
      const seen = await readJson(seenFile, null);
      if (JSON.stringify(seen?.stories) !== JSON.stringify(ids)) {
        await writeJson(seenFile, {at: new Date().toISOString(), stories: ids});
        const msg = `选题里有 ${pol.length} 条可能涉及政治，先停下等你决定：${pol.map((s) => `「${s.workingTitle}」（${s.politics.flag === 'yes' ? '涉及政治' : '拿不准'}：${s.politics.why}）`).join('；')}。不要的在工作台「选题」里删掉；确认没问题就直接接着做`;
        await status(runDir, {stage: 'review-select', message: msg}); log('⚠️ ' + msg);
        return;
      }
      log(`政治把关：${ids.join('、')} 已经停下给你看过，接着做`);
    }
    if (await pause('select', '采集和选题完成，等你审核选题')) return;

    // 3. enrich
    if (need('enrich', 'stories-enriched.json')) {
      await status(runDir, {stage: 'enrich', message: '正在阅读原文、收集配图'});
      stories = await enrich(stories, {runDir, cfg});
      await writeJson(path.join(runDir, 'stories-enriched.json'), stories);
    } else stories = await readJson(path.join(runDir, 'stories-enriched.json'));

    // 4. write
    if (need('write', 'stories-written.json')) {
      await status(runDir, {stage: 'write', message: '正在写稿'});
      stories = await writeStories(stories, {cfg, date: dp.iso, workDir: path.join(runDir, 'llm')});
      await status(runDir, {stage: 'write', message: 'AI 正在看图挑配图'});
      stories = await checkImages(stories, {cfg, workDir: path.join(runDir, 'llm')}); // 扔掉资料图、装饰插画等无关配图
      await writeJson(path.join(runDir, 'stories-written.json'), stories);
    } else stories = await readJson(path.join(runDir, 'stories-written.json'));
    if (await pause('write', '写稿完成，等你检查稿子和配图')) return;

    // 5. voice + timeline
    let timeline;
    if (need('voice', 'timeline.json') || !exists(path.join(runDir, 'narration.wav'))) {
      await status(runDir, {stage: 'voice', message: '正在配音、对齐字幕'});
      ({timeline} = await buildEpisode(stories, {cfg, runDir, dp, ffmpeg, ffprobe}));
      ran.add('voice');
    } else timeline = await readJson(path.join(runDir, 'timeline.json'));
    // 竖屏（Remotion）出片：先整理竖屏数据、算出竖屏版每段的时间（多了开场和每条的一句话总结），章节和目录按竖屏时间算
    const useRemotion = cfg.render?.engine === 'remotion' && !args.preview && !args.stills;
    const finalName = `${dp.iso}-${cfg.channel?.name || 'AI资讯'}.mp4`;
    let remo = null, pubTimeline = timeline;
    if (useRemotion) {
      const tf = path.join(runDir, 'timeline-remotion.json');
      if (ran.has('voice') || forced || !exists(tf) || !exists(path.join(runDir, finalName))) {
        await status(runDir, {stage: 'voice', message: '正在整理竖屏画面数据'});
        remo = await prepareRemotion(timeline, stories, {cfg, runDir, dp, ffmpeg, ffprobe});
        pubTimeline = remo.timeline;
      } else pubTimeline = await readJson(tf);
    }
    const info = publishInfo(pubTimeline, stories, {cfg, dp});
    await writeJson(path.join(runDir, 'publish-auto.json'), info); // 自动生成的版本，工作台「恢复」用
    const edited = await readJson(path.join(runDir, 'publish-edit.json'), null); // 工作台里改过的标题/简介/标签/评论/声明/分区
    if (edited) for (const k of ['title', 'desc', 'tags', 'comment']) if (edited[k]?.length) info[k] = edited[k];
    await writeJson(path.join(runDir, 'publish.json'), info);

    if (await pause('voice', '配音完成，等你试听')) return;

    const cover = path.join(runDir, 'cover.jpg');
    const classicCover = async () => {
      const headStory = stories.find(s => s.media?.length && s.media[0].kind === 'image') || stories.find(s => s.media?.length);
      await renderCover({channel: col.name || cfg.channel?.name, dateBig: `${dp.m}月${dp.d}日`, weekday: `星期${dp.weekday}`, headlines: stories.slice(0, 3).map(s => s.coverTitle || s.title), count: stories.length,
        countText: col.mode === 'github' ? `本周 ${stories.length} 个项目` : `今日 ${stories.length} 条速览`,
        image: headStory ? path.relative(path.join(runDir, '_page'), headStory.media[0].file).split(path.sep).join('/') : ''}, {runDir, outFile: cover, chromePath: cfg.render?.chromePath});
    };
    const classicPortrait = async () => renderCover(await portraitCoverData({stories, col, dp, runDir, variant: col.coverVariant || cfg.cover?.portraitVariant || 'A'}),
      {runDir, outFile: path.join(runDir, 'cover-portrait.jpg'), chromePath: cfg.render?.chromePath, page: 'cover-portrait.html', width: 1080, height: 1440});
    // 新封面（cover-hook.html）：横版 cover.jpg 给 B 站，竖版 cover-portrait.jpg（3:4）给抖音、快手、小红书、视频号。出错就退回旧样式。
    const hookCover = async (landscape) => {
      const data = await hookCoverData({stories, col, dp, runDir, landscape, channel: cfg.channel?.titleSign,
        variant: landscape ? cfg.cover?.hookLandscape : cfg.cover?.hookPortrait});
      await renderCover(data, {runDir, outFile: landscape ? cover : path.join(runDir, 'cover-portrait.jpg'), chromePath: cfg.render?.chromePath,
        page: 'cover-hook.html', width: landscape ? 1920 : 1080, height: landscape ? 1080 : 1440,
        onInit: r => { if (r?.overflow?.length) log(`⚠️ ${landscape ? '横版' : '竖版'}封面有字超出画面：${r.overflow.join('｜')}`); }});
    };
    const makeCover = async () => {
      const hook = (cfg.cover?.style || 'hook') === 'hook';
      if (hook) { try { await hookCover(true); } catch (e) { log('新横版封面没做出来，改用旧样式：' + e.message); await classicCover(); } }
      else await classicCover();
      // 竖版失败不影响横版和投稿（短视频平台会退回用横版封面）
      try {
        if (hook) { try { await hookCover(false); } catch (e) { log('新竖版封面没做出来，改用旧样式：' + e.message); await classicPortrait(); } }
        else await classicPortrait();
      } catch (e) { log('竖版封面没做出来（短视频平台会退回用横版封面）：' + e.message); }
    };
    if (args.stills) {
      await status(runDir, {stage: 'stills', message: '正在生成画面预览'});
      const times = timeline.segments.flatMap(s => [s.start + Math.min(2.2, (s.end - s.start) / 2), ...(s.media || []).map(m => (m.t0 + m.t1) / 2)]);
      const outDir = path.join(runDir, 'stills');
      await fsp.rm(outDir, {recursive: true, force: true});
      await renderStills(timeline, times, {runDir, outDir, chromePath: cfg.render?.chromePath});
      await makeCover();
      await status(runDir, {stage: 'review-stills', message: '画面预览已生成，等你确认后渲染视频'});
      log('预览图已生成：' + outDir);
      return;
    }

    // 6. render
    const final = path.join(runDir, args.preview ? 'preview.mp4' : `${dp.iso}-${cfg.channel?.name || 'AI资讯'}.mp4`);
    if (useRemotion && (need('render', path.basename(final)) || remo)) {
      await status(runDir, {stage: 'render', message: '正在用 Remotion 渲染竖屏视频'});
      if (!remo) remo = await prepareRemotion(timeline, stories, {cfg, runDir, dp, ffmpeg, ffprobe});
      log(`开始渲染竖屏视频 ${mmss(remo.episode.duration)}（Remotion）…`);
      let last = 0;
      const r = await renderRemotion({epKey: remo.epKey, outFile: final, concurrency: cfg.render?.remotionConcurrency, ffmpeg, ffprobe, loudness: cfg.render?.portrait?.loudness, onLine: line => {
        const m = line.match(/Rendered (\d+)\/(\d+)/);
        if (m && Date.now() - last > 5000) { last = Date.now(); status(runDir, {stage: 'render', message: `渲染 ${Math.round(m[1] / m[2] * 100)}%`, done: +m[1], total: +m[2]}); }
      }});
      log(`竖屏渲染完成，用时 ${Math.round(r.seconds)} 秒`);
      await makeCover();
      const d = await ffprobeDuration(ffprobe, final);
      log(`✅ 成片：${final}（${mmss(d)}）  封面：${cover}`);
    } else if (need('render', path.basename(final)) || args.preview) {
      await status(runDir, {stage: 'render', message: '正在渲染视频'});
      const silent = path.join(runDir, '_video.mp4');
      const toSec = args.preview ? Math.min(args.preview, timeline.duration) : undefined;
      log(`开始渲染 ${mmss(toSec ?? timeline.duration)}（${cfg.render?.workers || 4} 路并行）…`);
      const r = await renderVideo(timeline, {runDir, outFile: silent, ffmpeg, chromePath: cfg.render?.chromePath, workers: cfg.render?.workers || Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))), crf: cfg.render?.crf || 20, toSec,
        onProgress: p => status(runDir, {stage: 'render', message: `渲染 ${Math.round(p.done / p.total * 100)}%`, ...p})});
      log(`画面渲染完成：${r.frames} 帧（实际截图 ${r.captured}），用时 ${Math.round(r.seconds)} 秒`);
      await muxAudio({ffmpeg, video: silent, audio: path.join(runDir, 'narration.wav'), outFile: final});
      await fsp.rm(silent, {force: true});
      await makeCover();
      const d = await ffprobeDuration(ffprobe, final);
      log(`✅ 成片：${final}（${mmss(d)}）  封面：${cover}`);
    }
    if (args.preview) { await status(runDir, {stage: 'done', message: '预览完成', video: final}); return; }

    // 7. export: video, covers and text metadata for manual upload (no upload code in this project)
    const pkg = await exportPackage({runDir, info, video: final, coverLandscape: cover, coverPortrait: path.join(runDir, 'cover-portrait.jpg')});
    await status(runDir, {stage: 'done', message: '视频和投稿素材已导出：' + pkg, video: final, cover});
    log('✅ 视频和投稿素材已导出：' + pkg);
  } finally { try { fs.unlinkSync(lock); } catch {} }
}

// 工作台「重试失败来源」：只重新采集指定来源，合并进已有候选
async function recollect(args) {
  const cfg = loadConfig();
  const dp = args.date ? dateParts(new Date(args.date + 'T08:00:00+08:00')) : dateParts();
  const {col, runDir} = resolveRun(args, dp);
  setLogFile(path.join(runDir, 'run.log'));
  const ids = String(args.sources || '').split(',').filter(Boolean);
  const src = (await readJson(path.join(ROOT, 'sources.json'))).sources.filter(s => ids.includes(s.id)).map(s => ({...s, enabled: true}));
  if (!src.length) throw new Error('没有要重试的来源');
  await status(runDir, {stage: 'collect', message: `正在重新采集 ${src.length} 个来源`});
  const {items, report} = await collect({sources: src, windowHours: cfg.video?.windowHours || 30, chromePath: cfg.render?.chromePath, nonAI: !!col.nonAI});
  const old = await readJson(path.join(runDir, 'candidates.json'), []);
  const byUrl = new Map(old.map(i => [normUrl(i.url), i]));
  let next = Math.max(0, ...old.map(i => Number(String(i.id).replace(/^c/, '')) || 0)) + 1, added = 0;
  for (const it of items) {
    const prev = byUrl.get(normUrl(it.url));
    if (prev) { for (const x of it.seenIn) if (!prev.seenIn.includes(x)) prev.seenIn.push(x); continue; }
    const n = {...it, id: 'c' + next++}; old.push(n); byUrl.set(normUrl(n.url), n); added++;
  }
  await writeJson(path.join(runDir, 'candidates.json'), old);
  const rep = await readJson(path.join(runDir, 'collect-report.json'), {report: [], warnings: []});
  rep.report = [...rep.report.filter(r => !ids.includes(r.id)), ...report];
  await writeJson(path.join(runDir, 'collect-report.json'), rep);
  if (added && cfg.translate?.enabled !== false) { await status(runDir, {stage: 'collect', message: `正在翻译新增的 ${added} 条候选`}); await translateRun(runDir); }
  const msg = `重新采集完成：${report.filter(r => r.ok).length}/${report.length} 个来源成功，新增 ${added} 条候选`;
  log(msg); await status(runDir, {stage: 'review-select', message: msg});
}

async function voiceSamples() {
  const cfg = loadConfig();
  const dir = path.join(ROOT, 'runs', 'voice-samples');
  const text = '大家好，这里是每日AI资讯。今天是10月17日，星期六。OpenAI 上线了 ChatGPT Slides，可以直接在对话里生成和编辑演示文稿。';
  const voices = ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-XiaochenNeural', 'zh-TW-HsiaoChenNeural', 'zh-CN-YunxiNeural'];
  for (const v of voices) {
    try { await synthesize([{id: v, sentences: [{text}]}], {cfg: {...cfg, tts: {...cfg.tts, voice: v}}, outDir: dir}); log('✓ ' + v); } catch (e) { log('✗ ' + v + ' ' + e.message.slice(0, 120)); }
  }
  log('试听文件在：' + dir);
}

// Archive today's GitHub daily trending list to runs/_github-daily/<date>.json for the weekly column (failure does not stop the run)
async function archiveGithubDaily(iso) {
  try { const list = await fetchTrending('daily'); await saveDailyTrending(iso, list); log(`已存档今天的 GitHub 每日热榜（${list.length} 个项目），给每周 GitHub 板块用`); }
  catch (e) { log('GitHub 每日热榜存档失败（不影响本期）：' + e.message); }
}

const args = parseArgs(process.argv.slice(2));
const main = {run: runPipeline, recollect, voices: voiceSamples}[args.cmd];
if (!main) { console.log('Usage: node src/main.mjs [run|recollect|voices] [--column news|github] [--date YYYY-MM-DD] [--from stage] [--preview seconds] [--stills] [--auto] [--stop-after select|write|voice] [--run folder] [--sources ids]'); process.exit(1); }
const CMD_NAMES = {run: '制作', recollect: '重新采集'};
main(args).catch(async e => {
  log('❌ 出错：' + (e.stack || e.message)); process.exitCode = 1;
  const dp = args.date ? dateParts(new Date(args.date + 'T08:00:00+08:00')) : dateParts();
  const {runDir} = resolveRun(args, dp);
  if (CMD_NAMES[args.cmd]) try { fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({stage: 'error', message: e.message, updatedAt: new Date().toISOString()}, null, 2)); } catch {}
});
