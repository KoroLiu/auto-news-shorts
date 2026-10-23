// Collect candidate news from many free sources, with heat signals (points, upvotes, stars, hot-search rank, media coverage).
import fs from 'node:fs';
import path from 'node:path';
import {fetchText, fetchJson, log, writeJson, run} from './util.mjs';
import {pool} from './llm.mjs';
import {findChrome} from './render/cdp.mjs';
import {spawn} from 'node:child_process';
import {readDailyArchive, reposIn} from './github.mjs';
import {nonAiGroups, isBigTech} from './rank.mjs';

// ---------- text utils ----------
const ENT = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“'};
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e.toLowerCase()] ?? m));
}
export function stripHtml(s) {
  s = String(s ?? '');
  if (/&lt;\/?[a-z]/i.test(s) && !/<[a-z]/i.test(s)) s = decodeEntities(s); // entity-escaped HTML (Atom type="html")
  return decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}
const cdata = s => String(s ?? '').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
function tag(block, names) {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${n}>`, 'i'));
    if (m) return cdata(m[1]).trim();
  }
  return '';
}
export function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    let link = tag(b, ['link']);
    if (!link || /^\s*$/.test(link)) { const m = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)/i) || b.match(/<link[^>]*href=["']([^"']+)/i); link = m ? m[1] : ''; }
    const guid = tag(b, ['guid', 'id']);
    if (!/^https?:/.test(link) && /^https?:/.test(guid)) link = guid;
    const title = stripHtml(tag(b, ['title']));
    const html = tag(b, ['content:encoded', 'content', 'description', 'summary']);
    // Techmeme 的 link 是当天汇总页，description 里的第一个外链才是这条新闻的原文。
    let origUrl;
    if (/^https?:\/\/([^/]+\.)?techmeme\.com(?:\/|$)/i.test(link)) {
      for (const m of decodeEntities(html).matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
        try {
          const u = new URL(m[1], link);
          if (/^https?:$/.test(u.protocol) && !/(^|\.)techmeme\.com$/i.test(u.hostname)) { origUrl = u.href; break; }
        } catch {}
      }
    }
    const date = tag(b, ['pubDate', 'published', 'dc:date', 'updated', 'a10:updated']);
    const img = (html.match(/<img[^>]+src=["']([^"']+)/i) || b.match(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)/i) || b.match(/<enclosure[^>]+url=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)/i) || [])[1];
    if (title && link) items.push({title, url: decodeEntities(link.trim()), ...(origUrl ? {origUrl} : {}), summary: stripHtml(html).slice(0, 1200), html: html.slice(0, 20000), date: date ? new Date(date).toISOString?.() : null, image: img ? decodeEntities(img) : null});
  }
  return items.map(i => ({...i, date: i.date && !isNaN(new Date(i.date)) ? new Date(i.date).toISOString() : null}));
}

// ---------- AI relevance ----------
const AI_WORDS = ['ai', 'a.i.', 'artificial intelligence', 'llm', 'gpt', 'openai', 'anthropic', 'claude', 'gemini', 'deepmind', 'llama', 'mistral', 'qwen', 'deepseek', 'kimi', 'moonshot', 'glm', 'zhipu', 'minimax', 'doubao', 'ernie', 'hunyuan', 'agent', 'agentic', 'copilot', 'cursor', 'codex', 'chatgpt', 'sora', 'veo', 'midjourney', 'diffusion', 'transformer', 'nvidia', 'gpu', 'grok', 'xai', 'perplexity', 'hugging face', 'huggingface', 'machine learning', 'neural', 'model', 'inference', 'reasoning', 'multimodal', 'chatbot', 'stable diffusion', 'runway', 'eleven labs', 'elevenlabs', 'mcp', 'rag', 'fine-tun', 'benchmark', 'robot', 'humanoid', 'tpu', 'cuda', 'vllm', 'ollama', 'lmstudio', 'windsurf', 'devin', 'manus', 'genspark', 'notebooklm',
  '人工智能', '大模型', '模型', '智能体', '生成式', 'aigc', '算力', '芯片', '英伟达', '豆包', '文心', '通义', '千问', '混元', '智谱', '月之暗面', '阶跃', '百川', '零一万物', '商汤', '讯飞', '星火', '具身', '机器人', '多模态', '推理', '开源', '训练', '大语言', '语音合成', '视频生成', '图像生成', '编程', '自动驾驶', '机器学习', '深度学习', '神经网络', '数据中心', 'gpt', '元宝', '可灵', '即梦', '海螺', '扣子', 'trae', '小米mimo'];
const AI_RE = new RegExp(AI_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).map(w => /^[a-z.\- ]+$/.test(w) ? `\\b${w}` : w).join('|'), 'i');
export const isAI = s => AI_RE.test(String(s));

// ---------- OpenCLI (Agent-Reach) ----------
const num = v => { const n = Number(String(v ?? '').replace(/[,\s]/g, '').replace(/k$/i, '000').replace(/m$/i, '000000')); return Number.isFinite(n) ? n : 0; };
export function resolveOpenCli(configured) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const dirs = [configured && path.dirname(configured), path.join(home, '.agent-reach', 'tools', 'npm'), path.join(process.env.APPDATA || '', 'npm')].filter(Boolean);
  for (const d of dirs) {
    const pkg = path.join(d, 'node_modules', '@jackwener', 'opencli', 'package.json');
    try {
      const m = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      const bin = typeof m.bin === 'string' ? m.bin : m.bin?.opencli;
      if (bin) return {command: process.execPath, prefix: [path.join(path.dirname(pkg), bin)]};
    } catch {}
  }
  return null;
}


/** Open the user's Chrome profile (the one connected to the OpenCLI extension) if the bridge isn't reachable. */
/** OpenCLI JSON output: 1.x prints a bare array, 2.x prints {"ok":true,"data":[...]} (possibly after notice lines). Returns rows or null. */
export function parseOpenCliRows(out) {
  const s = String(out || '');
  const start = [s.indexOf('{"ok"'), s.indexOf('[')].filter(i => i >= 0).sort((a, b) => a - b)[0];
  if (start === undefined) return null;
  const close = s[start] === '[' ? ']' : '}';
  // trailing notices may follow the JSON, so try each closing bracket from the last one backwards
  for (let end = s.lastIndexOf(close); end > start; end = s.lastIndexOf(close, end - 1)) {
    let j; try { j = JSON.parse(s.slice(start, end + 1)); } catch { continue; }
    if (Array.isArray(j)) return j;
    if (j && j.ok === true && Array.isArray(j.data)) return j.data;
    return null;
  }
  return null;
}

export function launchChromeProfile(profileName, chromePath) {
  const userData = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
  let dir = null;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(userData, 'Local State'), 'utf8'));
    const cache = st.profile?.info_cache || {};
    for (const [d, info] of Object.entries(cache)) if (profileName && [info.name, info.gaia_name, info.user_name, info.shortcut_name].some(v => v && String(v).includes(profileName))) { dir = d; break; }
    dir = dir || st.profile?.last_used || 'Default';
  } catch { dir = 'Default'; }
  const exe = findChrome(chromePath && /chrome\.exe$/i.test(chromePath) ? chromePath : undefined);
  spawn(exe, [`--profile-directory=${dir}`, '--no-first-run', 'about:blank'], {detached: true, stdio: 'ignore', windowsHide: false}).unref();
  return dir;
}
const BRIDGE_DOWN = /extension|daemon|bridge|not connected|connect ECONNREFUSED|BROWSER_CONNECT|no browser|profile.*(offline|not found)/i;

// ---------- adapters ----------
const H = 3600 * 1000;
const adapters = {
  async rss(src) {
    const {text} = await fetchText(src.url, {maxBytes: 10 * 1024 * 1024});
    // ghRepos：文章里链到的 GitHub 仓库（每周 GitHub 板块用来算热度，比如 Simon Willison 博客里提到的项目）
    return parseFeed(text).map(i => ({...i, ghRepos: reposIn(i.html), html: undefined}));
  },
  async digest(src) { // AINews-like daily digests: keep latest issue text as heat context
    const {text} = await fetchText(src.url, {maxBytes: 20 * 1024 * 1024});
    const items = parseFeed(text).slice(0, 2);
    return items.map(i => ({...i, summary: i.summary.slice(0, 1200), digestText: stripHtml(i.html || i.summary).slice(0, 9000), isDigest: true}));
  },
  async hn(src, ctx) {
    const since = Math.floor((ctx.now - (src.hours || 36) * H) / 1000); // hours：每周 GitHub 板块看一周
    const [front, recent] = await Promise.all([
      fetchJson('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=60').catch(() => ({hits: []})),
      fetchJson(`https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=created_at_i>${since},points>40&hitsPerPage=200`).catch(() => ({hits: []})),
    ]);
    const seen = new Set(); const out = [];
    for (const h of [...front.hits, ...recent.hits]) {
      if (seen.has(h.objectID)) continue; seen.add(h.objectID);
      out.push({title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, summary: '', date: h.created_at, heat: {hnPoints: h.points || 0, hnComments: h.num_comments || 0}, discussUrl: `https://news.ycombinator.com/item?id=${h.objectID}`});
    }
    return out;
  },
  // Reddit refuses anonymous access, so read each subreddit's top posts of the day through the user's logged-in Chrome via OpenCLI.
  async reddit(src, ctx) {
    const cli = resolveOpenCli(src.opencliPath);
    if (!cli) throw new Error('未找到 OpenCLI（Agent-Reach），跳过 Reddit');
    const out = []; const fails = [];
    const readSub = async sub => {
      const r = await run(cli.command, [...cli.prefix, ...(src.profile ? ['--profile', src.profile] : []), 'reddit', 'subreddit', sub, '--sort', 'top', '--time', src.time || 'day', '--limit', String(src.limit || 15), '-f', 'json'], {timeoutMs: (src.timeoutSec || 90) * 1000});
      const rows = parseOpenCliRows(r.out);
      if (!rows) return (r.err + ' ' + r.out).replace(/\s+/g, ' ').slice(0, 120) || 'no output';
      for (const d of rows) {
        if (d.stickied) continue;
        const link = d.url_overridden_by_dest && !/redd\.it|reddit\.com/.test(d.url_overridden_by_dest) ? d.url_overridden_by_dest : d.url;
        out.push({title: d.title, url: link, summary: String(d.selftext || '').slice(0, 600), date: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null, heat: {redditScore: num(d.upvotes ?? d.score), redditComments: num(d.comments ?? d.num_comments)}, sub, discussUrl: d.url});
      }
      return null;
    };
    let pending = [...(src.subs || [])];
    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      if (attempt) { log('  Reddit：浏览器还没连上，30 秒后重试…'); await new Promise(r => setTimeout(r, 30000)); }
      const again = [];
      await pool(pending, src.concurrency || 2, async sub => { const err = await readSub(sub); if (err) { again.push(sub); if (attempt) fails.push(`r/${sub}(${err})`); } });
      pending = again;
    }
    if (fails.length) ctx.warn(`Reddit：${fails.length}/${(src.subs || []).length} 个版块读取失败（Chrome 是否已打开、Reddit 是否已登录？）例：${fails[0]}`);
    if (fails.length === (src.subs || []).length && fails.length) throw new Error('Reddit 全部读取失败：' + fails[0]);
    return out;
  },
  // since：daily 每日热榜 / weekly 本周热榜
  async github_trending(src) { return fetchTrending(src.since || 'daily'); },
  // 每日热榜存档（runs\_github-daily），合并最近 days 天：上榜几天、单日最多涨星
  async github_archive(src, ctx) {
    const {items, days} = readDailyArchive(ctx.now, src.days || 7);
    if (!days.length) throw new Error('还没有每日热榜存档（每天采集时会自动存）');
    log(`  GitHub 每日热榜存档：${days.length} 天（${days.join('、')}），${items.length} 个项目`);
    return items;
  },
  async hf_trending() {
    const j = await fetchJson('https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=40');
    return j.map((m, i) => ({title: m.id, url: `https://huggingface.co/${m.id}`, summary: `Hugging Face 热门模型第 ${i + 1} 名; pipeline: ${m.pipeline_tag || '-'}; likes: ${m.likes}; downloads: ${m.downloads}`, date: m.createdAt || null, heat: {hfTrendingRank: i + 1, hfLikes: m.likes || 0}}));
  },
  async hf_papers() {
    const j = await fetchJson('https://huggingface.co/api/daily_papers?limit=30');
    return j.map(p => ({title: p.paper?.title || p.title, url: `https://huggingface.co/papers/${p.paper?.id}`, summary: (p.paper?.summary || '').slice(0, 700), date: p.publishedAt || p.paper?.publishedAt || null, heat: {paperUpvotes: p.paper?.upvotes || 0}}));
  },
  async hf_orgs(src, ctx) {
    const out = [];
    await pool(src.orgs || [], 6, async org => {
      try {
        const j = await fetchJson(`https://huggingface.co/api/models?author=${encodeURIComponent(org)}&sort=createdAt&direction=-1&limit=8`);
        for (const m of j) out.push({title: m.id, url: `https://huggingface.co/${m.id}`, summary: `pipeline: ${m.pipeline_tag || '-'}; likes: ${m.likes}; downloads: ${m.downloads}`, date: m.createdAt || null, heat: {hfLikes: m.likes || 0}, org});
      } catch (e) { ctx.warn(`hf ${org}: ${e.message}`); }
    });
    return out;
  },
  async weibo_hot() {
    const j = await fetchJson('https://weibo.com/ajax/side/hotSearch', {headers: {referer: 'https://weibo.com/'}});
    return (j.data?.realtime || []).filter(x => x.word).map((x, i) => ({title: x.word, url: `https://s.weibo.com/weibo?q=${encodeURIComponent('#' + x.word + '#')}`, summary: x.label_name || '', date: null, heat: {weiboRank: i + 1, weiboHot: x.num || x.raw_hot || 0}}));
  },
  // X / Twitter official accounts, read through the user's own logged-in Chrome via OpenCLI (Agent-Reach).
  async x_accounts(src, ctx) {
    const cli = resolveOpenCli(src.opencliPath);
    if (!cli) throw new Error('未找到 OpenCLI（Agent-Reach），跳过 X 账号');
    const out = []; let okCount = 0; const fails = []; const renamed = [];
    // make sure the browser bridge is up; open the Chrome profile automatically if needed
    const probe = await run(cli.command, [...cli.prefix, ...(src.profile ? ['--profile', src.profile] : []), 'twitter', 'tweets', 'OpenAI', '--limit', '1', '-f', 'json'], {timeoutMs: 60000});
    if (probe.code !== 0 && BRIDGE_DOWN.test(probe.err + probe.out) && src.autoOpenChrome !== false) {
      const dir = launchChromeProfile(src.chromeProfileName, ctx.chromePath);
      log(`OpenCLI 未连接，已自动打开 Chrome（个人资料 ${dir}），等待扩展连接…`);
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const again = await run(cli.command, [...cli.prefix, ...(src.profile ? ['--profile', src.profile] : []), 'twitter', 'tweets', 'OpenAI', '--limit', '1', '-f', 'json'], {timeoutMs: 60000});
        if (again.code === 0 || !BRIDGE_DOWN.test(again.err + again.out)) break;
      }
    }
    await pool(src.accounts || [], src.concurrency || 2, async acc => {
      const handle = typeof acc === 'string' ? acc : acc.handle;
      const kind = (typeof acc === 'object' && acc.kind) || 'official';
      const args = [...cli.prefix, ...(src.profile ? ['--profile', src.profile] : []), 'twitter', 'tweets', handle, '--limit', String(src.limit || 15), '-f', 'json'];
      const r = await run(cli.command, args, {timeoutMs: (src.timeoutSec || 60) * 1000});
      const rows = parseOpenCliRows(r.out);
      if (!rows) {
        const msg = (r.err + ' ' + r.out).replace(/\s+/g, ' ');
        fails.push(`${handle}(${msg.slice(msg.indexOf('{') >= 0 ? msg.indexOf('{') : 0).slice(0, 80)})`);
        // "Could not resolve" = handle gone; an empty/suspended timeline (like @xai after it moved) usually means it moved too
        if (/Could not resolve|not found|no recent tweets|private or suspended/i.test(msg)) { renamed.push(handle); log(`  ⚠️ X @${handle} 找不到或已清空——很可能已改名或注销，请到 sources.json 更新账号名`); }
        else log(`  X @${handle} 读取失败`);
        return;
      }
      okCount++;
      log(`  X @${handle}：${Array.isArray(rows) ? rows.length : 0} 条`);
      for (const t of Array.isArray(rows) ? rows : []) {
        const text = String(t.text || t.full_text || '').trim(); if (!text) continue;
        const author = String(t.author || t.screen_name || handle);
        const isRT = t.is_retweet === true || /^RT @/.test(text);
        const isReply = /^@\w+/.test(text) && !text.includes('http');
        if (isReply) continue;
        const likes = num(t.likes ?? t.like_count ?? t.favorite_count ?? t.favorites), rts = num(t.retweets ?? t.retweet_count), views = num(t.views ?? t.view_count);
        const date = t.created_at ? new Date(t.created_at).toISOString() : null;
        out.push({title: `@${author}：${text.replace(/\s+/g, ' ').slice(0, 160)}`, url: t.url || `https://x.com/${author}/status/${t.id}`, summary: text.slice(0, 1500), date,
          heat: {xLikes: likes, xRetweets: rts, xViews: views}, tweet: {handle: author, name: acc.name || author, text, isRetweet: isRT, links: (text.match(/https?:\/\/\S+/g) || []).slice(0, 3)},
          kindOverride: isRT ? 'community' : kind});
      }
    });
    ctx.warn(`X：${okCount}/${(src.accounts || []).length} 个账号读取成功${fails.length ? '；失败：' + fails.slice(0, 8).join('、') : ''}`);
    if (renamed.length) ctx.warn(`⚠️ 注意：X 账号 ${renamed.map(h => '@' + h).join('、')} 找不到，很可能已改名或注销，请更新 sources.json`);
    if (!okCount && (src.accounts || []).length) throw new Error('X 账号全部读取失败（Chrome 是否已打开并连接 OpenCLI 扩展？）' + (fails[0] ? ' 例：' + fails[0] : ''));
    return out;
  },
  async anthropic_news(src) {
    const {text} = await fetchText(src.url);
    const out = []; const seen = new Set();
    for (const m of text.matchAll(/href="(\/(?:news|research)\/[a-z0-9-]+)"[\s\S]{0,1500}?<\/a>/gi)) {
      const href = m[1]; if (seen.has(href)) continue; seen.add(href);
      const block = m[0];
      const title = stripHtml((block.match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/i) || block.match(/class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\//i) || [])[1] || '');
      const dateStr = (stripHtml(block).match(/([A-Z][a-z]{2,8}\.? \d{1,2}, 20\d\d)/) || [])[1];
      if (title) out.push({title, url: 'https://www.anthropic.com' + href, summary: '', date: dateStr ? new Date(dateStr).toISOString() : null});
    }
    return out.slice(0, 25);
  },
};

/** GitHub Trending 热榜（不过滤）：since=daily 每日 / weekly 本周 / monthly 本月 */
export async function fetchTrending(since = 'daily') {
  const {text} = await fetchText(`https://github.com/trending?since=${since}`);
  const key = since === 'weekly' ? 'ghStarsWeek' : since === 'monthly' ? 'ghStarsMonth' : 'ghStarsToday';
  const out = [];
  for (const art of text.split('<article').slice(1)) {
    const repo = (art.match(/<h2[^>]*>[\s\S]*?href="\/([^"]+)"/) || [])[1]; if (!repo) continue;
    const desc = stripHtml((art.match(/<p class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '');
    const gained = parseInt(((art.match(/([\d,]+)\s+stars? (?:today|this week|this month)/) || [])[1] || '0').replace(/,/g, ''), 10);
    const total = parseInt(((art.match(/href="\/[^"]+\/stargazers"[^>]*>[\s\S]*?([\d,]+)\s*<\/a>/) || [])[1] || '0').replace(/,/g, ''), 10);
    const language = (art.match(/itemprop="programmingLanguage">([^<]+)</) || [])[1] || '';
    out.push({title: `${repo}: ${desc}`.slice(0, 200), url: `https://github.com/${repo}`, summary: desc, date: null, heat: {[key]: gained, ghStars: total}, language, image: `https://opengraph.githubassets.com/1/${repo}`});
  }
  return out;
}

// ---------- main ----------
export async function collect({sources, now = Date.now(), windowHours = 30, outDir, chromePath, nonAI = false}) {
  const warnings = []; const report = [];
  const ctx = {now, chromePath, warn: m => { warnings.push(m); log(m); }};
  const all = [];
  await pool(sources.filter(s => s.enabled !== false), 8, async src => {
    const t = Date.now();
    try {
      const fn = adapters[src.type]; if (!fn) throw new Error('未知类型 ' + src.type);
      let items = await fn(src, ctx);
      const raw = items.length;
      items = items.filter(i => i.title && i.url);
      // time window (undated trending items are current by definition)
      items = items.filter(i => i.isDigest || !i.date || (now - new Date(i.date).getTime()) <= windowHours * H || ['trending'].includes(src.kind));
      if (src.type === 'hf_orgs') items = items.filter(i => i.date && (now - new Date(i.date).getTime()) <= 48 * H);
      // 和 AI 无关的：一般扔掉；板块要非 AI 科技大事（nonAI）时，综合科技来源（techWide）的先留下、标 nonAI，最后只留够大的
      if (!src.aiOnly && !['hf_trending', 'hf_papers', 'hf_orgs', 'x_accounts'].includes(src.type)) items = items.flatMap(i => i.isDigest || isAI(i.title + ' ' + i.summary.slice(0, 300)) ? [i] : nonAI && src.techWide ? [{...i, nonAI: true}] : []);
      for (const i of items) all.push({...i, source: src.id, sourceName: i.tweet ? `X @${i.tweet.handle}` : src.name, kind: i.kindOverride || src.kind, lang: src.lang});
      report.push({id: src.id, ok: true, raw, kept: items.length, ms: Date.now() - t});
    } catch (e) {
      report.push({id: src.id, ok: false, error: String(e.message || e).slice(0, 200), ms: Date.now() - t});
    }
  });
  // dedupe by URL；sameOutlet=同一家网站的另一个订阅（如 Ars Technica 全站和 Ars AI 频道），同一篇只算一个来源
  const outlet = Object.fromEntries(sources.filter(s => s.sameOutlet).map(s => [s.id, s.sameOutlet]));
  const outletOf = id => outlet[id] || id;
  const byUrl = new Map();
  for (const it of all) {
    const key = normUrl(it.url);
    const prev = byUrl.get(key);
    if (!prev) byUrl.set(key, {...it, seenIn: [it.source]});
    else { if (!prev.seenIn.some(x => outletOf(x) === outletOf(it.source))) prev.seenIn.push(it.source); prev.heat = mergeHeat(prev.heat, it.heat); if (!prev.summary && it.summary) prev.summary = it.summary; if (prev.kind !== 'official' && it.kind === 'official') { prev.kind = 'official'; prev.sourceName = it.sourceName; } if (!it.nonAI) delete prev.nonAI; }
  }
  let merged = [...byUrl.values()];
  // 非 AI 的只留「全网级大事」的苗头（2 个以上来源、Techmeme、HN 600 分以上），其余不进候选
  if (nonAI) {
    const big = new Set(nonAiGroups(merged).filter(isBigTech).flat());
    const before = merged.filter(i => i.nonAI).length;
    merged = merged.filter(i => !i.nonAI || big.has(i));
    log(`非 AI 科技新闻：${before} 条里留下 ${big.size} 条够大的`);
  }
  const items = merged.map((it, i) => ({id: 'c' + (i + 1), ...it}));
  const ok = report.filter(r => r.ok).length;
  log(`采集完成：${ok}/${report.length} 个来源成功，${items.length} 条候选`);
  const failed = report.filter(r => !r.ok);
  if (failed.length) log('失败来源：' + failed.map(r => `${r.id}(${r.error})`).join('；'));
  if (outDir) { await writeJson(path.join(outDir, 'collect-report.json'), {report, warnings}); await writeJson(path.join(outDir, 'candidates.json'), items); }
  return {items, report, warnings};
}

// 同一网址从几个来源来（比如本周热榜 + 每日热榜存档）：热度取大的，排名取小的
function mergeHeat(a = {}, b = {}) {
  const h = {...a};
  for (const [k, v] of Object.entries(b || {})) h[k] = h[k] === undefined ? v : k.endsWith('Rank') ? Math.min(h[k], v) : Math.max(h[k], v);
  return h;
}

export function normUrl(u) {
  try { const x = new URL(u); x.hash = ''; for (const k of [...x.searchParams.keys()]) if (/^(utm_|ref$|source$|spm|from$)/i.test(k)) x.searchParams.delete(k); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '') + (x.search || '')).toLowerCase(); } catch { return String(u).toLowerCase(); }
}
