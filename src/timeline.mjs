// Build the full episode: narration per segment → audio placement → subtitle cues, card focus, evidence windows.
import path from 'node:path';
import {synthesize, timeSegment, mixNarration} from './tts/tts.mjs';
import {ffprobeDuration, writeJson, log, mmss, dateParts} from './util.mjs';
import {CHAPTERS} from './rank.mjs';
import {buildChapters} from './chapters.mjs';

const dateLabel = d => { const x = new Date(d); return isNaN(x) ? '' : new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false}).format(x); };
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

export function introSentences({channel, dp, stories, greeting, col = null}) {
  const heads = stories.slice(0, 2).map(s => s.title);
  const weekly = String(col?.schedule || '').startsWith('weekly');
  const s = [
    {text: `${greeting}，这里是${channel}。`, card: -1},
    {text: `今天是${dp.m}月${dp.d}日，星期${dp.weekday}。`, card: -1},
  ];
  if (heads.length) s.push({text: `${col?.introLead || '今天最值得关注的是'}：${heads[0]}${heads[1] ? `；以及${heads[1]}` : ''}。`, card: -1});
  s.push({text: weekly ? '屏幕上是本期的全部内容，下面一个一个来看。' : '屏幕上是今天的主要内容，下面来看详细报道。', card: -1});
  return s;
}

export async function buildEpisode(stories, {cfg, runDir, dp, ffmpeg, ffprobe}) {
  const channel = cfg.column?.name || cfg.channel?.name || '每日AI资讯';
  const hour = dateParts().hour; // 北京时间，不用电脑本地时区
  const greeting = cfg.column?.greeting || cfg.channel?.greeting || (hour >= 4 && hour < 11 ? '早上好' : hour >= 18 ? '晚上好' : '大家好');
  const segs = [
    {id: 'intro', type: 'intro', sentences: introSentences({channel, dp, stories, greeting, col: cfg.column})},
    ...stories.map(s => ({id: s.id, type: 'item', story: s, sentences: s.narration})),
    {id: 'outro', type: 'outro', sentences: [{text: cfg.column?.outroFirst || '以上就是今天的全部内容。', card: -1}, {text: cfg.column?.outroLine || cfg.channel?.outroLine || '觉得有用的话，欢迎点赞关注，我们明天见！', card: -1}]},
  ];
  const audioDir = path.join(runDir, 'audio');
  const tts = await synthesize(segs, {cfg, outDir: audioDir});
  const fps = 30;
  let cursor = 0; const placements = []; const segments = []; let alignWarn = 0;
  for (const seg of segs) {
    const a = tts[seg.id]; const dur = await ffprobeDuration(ffprobe, a.file);
    const tm = timeSegment(seg.sentences, a.words, dur, {maxUnits: cfg.video?.subtitleMaxChars || 22});
    if (tm.matchRatio < .6) alignWarn++;
    const lead = seg.type === 'intro' ? .35 : seg.type === 'outro' ? .45 : .5;
    const tail = seg.type === 'outro' ? 1.8 : .35;
    const start = cursor, at = start + lead;
    let end = at + dur + tail;
    if (seg.type === 'intro') end = Math.max(end, start + 9);
    end = Math.round(end * fps) / fps;
    placements.push({file: a.file, at});
    const cues = tm.cues.map(c => ({text: c.text, t0: +(at + c.t0).toFixed(3), t1: +(at + c.t1).toFixed(3)}));
    if (cues.length) cues[cues.length - 1].t1 = Math.min(end - .05, cues[cues.length - 1].t1);
    const base = {type: seg.type, id: seg.id, start: +start.toFixed(3), end: +end.toFixed(3), cues};
    if (seg.type === 'item') {
      const s = seg.story;
      const focus = tm.sentences.filter(x => x.card >= 0).map(x => ({card: x.card, t0: +(at + x.a).toFixed(3), t1: +(at + x.b).toFixed(3)}));
      // 配图弹出时机：AI 看图时指定了对应哪一句（m.sentence）就在那句弹出（最早第 2 句，避开标题入场）；否则默认第 2、4 句。前后两张不重叠。
      const media = [];
      const sents = tm.sentences;
      const mlist = [...(s.tweet && s.tweetZh ? [{kind: 'tweet'}] : []), ...(s.media || [])];
      let lastEnd = -1;
      mlist.forEach((m, k) => {
        if (dur < 6) return;
        const want = Number.isInteger(m.sentence) && m.sentence >= 0 ? Math.max(1, m.sentence) : -1;
        const si = want >= 0 && sents[want] && sents[want].a >= lastEnd + .3 ? want : 1 + k * 2;
        let t0, t1;
        if (sents[si]) { t0 = sents[si].a; t1 = Math.max(sents[si].b, t0 + 3.6); }
        else if (k === 0) { t0 = dur * .38; t1 = dur * .8; }
        else return;
        t1 = Math.min(t1, t0 + 7.5, dur - .7);
        if (t1 - t0 < 2.4 || t0 < lastEnd + .3) return;
        lastEnd = t1;
        if (m.kind === 'tweet') media.push({type: 'tweet', name: s.tweet.name, handle: s.tweet.handle, textZh: s.tweetZh, text: s.tweet.text.replace(/https?:\/\/\S+/g, '').trim().slice(0, 260), date: s.tweet.date ? dateLabel(s.tweet.date) : '', t0: +(at + t0).toFixed(3), t1: +(at + t1).toFixed(3)});
        else media.push({src: path.relative(path.join(runDir, '_page'), m.file).split(path.sep).join('/'), t0: +(at + t0).toFixed(3), t1: +(at + t1).toFixed(3), caption: m.caption ? `${m.caption} · ${host(m.url)}` : `${m.kind === 'screenshot' ? '截图' : '图源'} · ${host(m.url)}`});
      });
      segments.push({...base, chapter: s.chapter, short: s.short, title: s.title, sourceLine: s.sourceLine, cards: s.cards, focus, media, url: s.primary?.url});
    } else if (seg.type === 'intro') {
      const groups = [];
      for (const ch of chapterOrder(stories)) { const its = stories.filter(s => s.chapter === ch).map(s => s.title); if (its.length) groups.push({chapter: ch, items: its}); }
      segments.push({...base, chapter: null, short: '概览', title: `${dp.m}月${dp.d}日 · ${cfg.column?.introTitle || '今日 AI 资讯概览'}`, subtitle: '', overview: groups});
    } else {
      segments.push({...base, chapter: null, short: '结尾', title: cfg.column?.outroTitle || '今天的资讯就到这里', subtitle: cfg.column?.outroSub || '感谢收看，我们明天见', chip: cfg.column?.outroChip || cfg.channel?.outroChip || '每天更新 · 欢迎关注'});
    }
    cursor = end;
  }
  const duration = +cursor.toFixed(3);
  segments[0].subtitle = `共 ${stories.length} 条 · 约 ${Math.max(1, Math.round(duration / 60))} 分钟`;
  if (alignWarn) log(`提示：${alignWarn} 段字幕对齐使用了估算（不影响播放）`);
  const narration = path.join(runDir, 'narration.wav');
  await mixNarration({ffmpeg, placements, total: duration, outFile: narration, bgm: cfg.audio?.bgm ? {file: path.resolve(cfg.audio.bgm), volume: cfg.audio.bgmVolume} : null});
  const chapters = chapterOrder(stories);
  const timeline = {width: 1920, height: 1080, fps, channel: {name: channel}, date: dp.iso, dateLabel: `${dp.m}月${dp.d}日 周${dp.weekday}`, chapters, duration, segments};
  await writeJson(path.join(runDir, 'timeline.json'), timeline);
  log(`时间轴完成：${segments.length} 段，总时长 ${mmss(duration)}`);
  return {timeline, narration};
}

// 本期出现的栏目，按老栏目顺序；板块自定义的栏目按出现顺序
function chapterOrder(stories) {
  const seen = [...new Set(stories.map(s => s.chapter))];
  return [...CHAPTERS.filter(c => seen.includes(c)), ...seen.filter(c => !CHAPTERS.includes(c))];
}

export function publishInfo(timeline, stories, {cfg, dp}) {
  const channel = cfg.column?.titleTag || cfg.channel?.name || '每日AI资讯';
  const items = timeline.segments.filter(s => s.type === 'item');
  // 标题：【署名】+ 头条的「数字式」标题，如「【署名】提速3倍、便宜七成！匿名霸榜的神秘模型终于露面」；
  // 不写日期和栏目名（栏目名放简介开头）。头条没有数字式标题时，用前两条新闻标题。全平台同一种写法，短平台用 hookShort。
  const sign = `【${cfg.channel?.titleSign || cfg.channel?.name || '每日AI资讯'}】`;
  const lead = stories.find(s => s.id === items[0]?.id) || {};
  const heads = items.slice(0, 2).map(s => s.title);
  let title = lead.hookTitle ? sign + lead.hookTitle : `${sign}${heads.join('；')}`;
  if (title.length > 80) title = `${sign}${heads[0]}`;
  if (title.length > 80) title = title.slice(0, 80);
  const shortHook = lead.hookShort || '';
  const descTag = `【${channel} ${dp.m}.${dp.d}】`;
  const toc = items.map(s => `${mmss(s.start)}  ${s.title}`);
  const links = items.map((s, i) => `${i + 1}. ${s.title}\n${s.url || ''}`);
  const tail = `\n\n${cfg.metadata?.aiStatement || '本视频由 AI 辅助整理资讯、撰写文稿并配音，信息以原文为准。'}`;
  const head = `${dp.iso} ${cfg.column?.descLead || 'AI 资讯速览'}，共 ${items.length} ${cfg.column?.mode === 'github' ? '个项目' : '条'}。`; // GitHub 板块：「本周 GitHub 热门 AI 开源项目，共 5 个项目」
  const linkHead = cfg.column?.mode === 'github' ? '项目地址：' : '原文链接：';
  let desc = `${head}\n\n${toc.join('\n')}\n\n${linkHead}\n${links.join('\n')}`;
  if (desc.length + tail.length > 1990) {
    desc = `${head}\n\n${toc.join('\n')}\n\n${linkHead}`;
    for (const l of links) { if (desc.length + l.length + tail.length + 2 > 1990) break; desc += '\n' + l; }
  }
  desc += tail;
  const tags = [...new Set([...(cfg.metadata?.baseTags || ['AI', '人工智能', '大模型', 'AI资讯', '科技']), ...(cfg.column?.tags || []), ...stories.flatMap(s => s.tags || [])])].filter(t => t && t.length <= 20).slice(0, 10);
  const comment = `本期时间轴（点击时间可跳转）：\n${toc.join('\n')}`;
  const chapters = buildChapters(items, timeline.duration); // 审核通过后设成 B 站播放器的分段章节
  return {title, shortHook, descTag, desc, tags, comment, toc, chapters};
}
