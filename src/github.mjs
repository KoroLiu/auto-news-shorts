// 每周 GitHub 项目板块：每日热榜存档、往期防重复（硬性，按 owner/repo）、按仓库归并候选、仓库资料（Star、语言、README）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {ROOT, dateParts, fetchText, fetchJson, writeJson, log} from './util.mjs';
import {isExported} from './export.mjs';
import {heatOf} from './rank.mjs';
import {pool} from './llm.mjs';
import {runNameFor} from './columns.mjs';

const ARCHIVE = path.join(ROOT, 'runs', '_github-daily');
const NOT_REPO = /^(trending|topics|collections|orgs|features|sponsors|marketplace|explore|settings|login|signup|about|pricing|enterprise|readme|apps|search|users|site|security|customer-stories|resources|solutions|team|events|notifications|codespaces|issues|pulls|copilot|github-copilot|models|blog|contact|join|account|organizations|stars|watching)$/i;

/** github.com/owner/repo 的网址 → 'owner/repo'（小写，用来比较）；不是仓库就返回 null。 */
export function repoOf(url) {
  const m = String(url || '').match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
  if (!m || NOT_REPO.test(m[1])) return null;
  const repo = m[2].replace(/\.git$/i, '');
  if (!repo || repo === '.' || repo === '..') return null;
  return `${m[1]}/${repo}`.toLowerCase();
}
/** 一段文字里提到的仓库（如 Simon Willison 博客、Reddit 帖子正文里的链接） */
export function reposIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/gi)) { const r = repoOf(m[0]); if (r) out.add(r); }
  return [...out];
}

// ---------- 每日热榜存档：每天采集时（不管哪个板块）顺便存一份，周日那期合并 ----------
export async function saveDailyTrending(iso, items) {
  if (!items?.length) return;
  await writeJson(path.join(ARCHIVE, `${iso}.json`), {date: iso, savedAt: new Date().toISOString(), items});
}

/** 读最近 days 天的每日热榜存档，按仓库合并：上榜几天、单日最多涨星。没有存档的日子，从那天的期数文件夹 candidates.json 里补（存档功能加上之前的数据）。 */
export function readDailyArchive(now = Date.now(), days = 7) {
  const byRepo = new Map(); const used = [];
  for (let i = 0; i < days; i++) {
    const iso = dateParts(new Date(now - i * 86400000)).iso;
    let list = null;
    try { list = JSON.parse(fs.readFileSync(path.join(ARCHIVE, `${iso}.json`), 'utf8')).items; } catch {}
    if (!list) for (const d of safeDirs().filter(n => n.startsWith(iso))) {
      try { const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'runs', d, 'candidates.json'), 'utf8').replace(/^﻿/, '')); const g = c.filter(x => (x.seenIn || [x.source]).includes('gh-trending') && repoOf(x.url)); if (g.length) { list = g; break; } } catch {}
    }
    if (!list?.length) continue;
    used.push(iso);
    for (const it of list) {
      const r = repoOf(it.url); if (!r) continue;
      const prev = byRepo.get(r);
      const today = it.heat?.ghStarsToday || 0;
      if (!prev) byRepo.set(r, {...it, date: null, heat: {ghStarsToday: today, ghStars: it.heat?.ghStars || 0, ghTrendingDays: 1}, trendingDates: [iso]});
      else { prev.heat.ghStarsToday = Math.max(prev.heat.ghStarsToday, today); prev.heat.ghStars = Math.max(prev.heat.ghStars, it.heat?.ghStars || 0); prev.heat.ghTrendingDays++; prev.trendingDates.push(iso); }
    }
  }
  return {items: [...byRepo.values()], days: used};
}
const safeDirs = () => { try { return fs.readdirSync(path.join(ROOT, 'runs')); } catch { return []; } };

// ---------- Hard de-duplication: repos featured by this column in the last 8 weeks ----------
/** Looks back `weeks` weeks; only runs that reached the export step (exported.json) count. */
export function recentRepos(col, iso, {weeks = 8, runsDir = path.join(ROOT, 'runs')} = {}) {
  const out = new Map(); // repo -> 哪一期
  for (let i = 1; i <= weeks * 7; i++) {
    const d = dateParts(new Date(new Date(iso + 'T12:00:00+08:00').getTime() - i * 86400000)).iso;
    const dir = path.join(runsDir, runNameFor(col, d));
    if (!isExported(dir)) continue;
    let stories = [];
    for (const f of ['stories-written.json', 'stories-selected.json']) { try { stories = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, '')); break; } catch {} }
    for (const s of stories) {
      const r = s.repo || repoOf(s.primary?.url) || (s.items || []).map(x => repoOf(x.url)).find(Boolean);
      if (r && !out.has(r)) out.set(r, path.basename(dir));
    }
  }
  return out;
}

// ---------- 候选：按仓库归并（不按标题聚类）----------
/** 热度：本周涨星最重要，其次上每日热榜几天、单日涨星、HN/Reddit 讨论、被 GitHub 以外的几个来源提到。 */
function ghScore(h) {
  return Math.round((20 * Math.log10(1 + (h.ghStarsWeek || 0)) + 8 * Math.log10(1 + (h.ghStarsToday || 0)) + 5 * (h.ghTrendingDays || 0)
    + 12 * Math.log10(1 + (h.hnPoints || 0)) + 10 * Math.log10(1 + (h.redditScore || 0)) + 9 * h.sources.filter(x => !x.startsWith('gh-')).length) * 10) / 10; // 热榜和存档是同一个信号，只数 GitHub 以外的来源
}

/** items：采集到的全部条目（热榜、HN、Reddit、博客……）。只有指向 GitHub 仓库的才成为候选；HN/Reddit/博客里提到某个仓库，就算这个仓库的热度。 */
export function buildGithubCandidates(items, {exclude = new Map(), max = 60, quiet = false} = {}) {
  const digests = items.filter(i => i.isDigest);
  const groups = new Map(); // repo -> {self: [], mentions: []}
  const add = (r, it, self) => { if (!groups.has(r)) groups.set(r, {self: [], mentions: []}); groups.get(r)[self ? 'self' : 'mentions'].push(it); };
  for (const it of items) {
    if (it.isDigest) continue;
    const self = repoOf(it.url);
    if (self) { add(self, it, true); continue; }
    for (const r of [...new Set([...(it.ghRepos || []), ...reposIn(it.summary)])].slice(0, 3)) add(r, it, false);
  }
  const skipped = [];
  const list = [];
  for (const [repo, g] of groups) {
    if (exclude.has(repo)) { skipped.push(`${repo}（${exclude.get(repo)} 讲过）`); continue; }
    const all = [...g.self, ...g.mentions];
    const heat = {...heatOf(all), noAge: true};
    // 只被博客/帖子顺手提到、又不在热榜上的仓库：要有一点讨论热度才算候选
    if (!g.self.some(i => i.kind === 'trending') && !(heat.hnPoints >= 50 || heat.redditScore >= 100 || heat.sources.length >= 2)) continue;
    heat.score = ghScore(heat);
    // 第一条放仓库本身（热榜条目），选题时显示它的网址
    const items2 = [...g.self.sort((a, b) => (b.kind === 'trending') - (a.kind === 'trending')), ...g.mentions];
    if (!g.self.length) items2.unshift({id: 'gh:' + repo, title: `${repo}`, url: `https://github.com/${repo}`, summary: '', kind: 'trending', source: 'gh-mention', sourceName: 'GitHub', seenIn: []});
    list.push({repo, items: items2, heat});
  }
  if (skipped.length && !quiet) log(`防重复：最近 8 周讲过的 ${skipped.length} 个项目已从候选里去掉：${skipped.join('、')}`);
  list.sort((a, b) => b.heat.score - a.heat.score);
  return {candidates: list.slice(0, max).map((c, i) => ({key: 'k' + (i + 1), ...c})), digests, skipped};
}

/** HN 上这一周有没有人发这个仓库（按网址搜），有就把分数、评论数算进热度。 */
export async function addHnHeat(candidates, {now = Date.now(), days = 8} = {}) {
  const since = Math.floor((now - days * 86400000) / 1000);
  let hit = 0;
  await pool(candidates, 6, async c => {
    try {
      const j = await fetchJson(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent('github.com/' + c.repo)}&restrictSearchableAttributes=url&numericFilters=created_at_i>${since}&hitsPerPage=5`, {timeoutMs: 12000});
      const best = (j.hits || []).filter(h => repoOf(h.url) === c.repo).sort((a, b) => (b.points || 0) - (a.points || 0))[0];
      if (!best) return;
      hit++;
      c.heat.hnPoints = Math.max(c.heat.hnPoints || 0, best.points || 0);
      c.heat.hnComments = Math.max(c.heat.hnComments || 0, best.num_comments || 0);
      if (!c.heat.sources.includes('hn')) c.heat.sources.push('hn');
      c.heat.score = ghScore(c.heat);
      c.items.push({id: 'hn:' + best.objectID, title: `[HN] ${best.title}`, url: c.items[0].url, summary: '', kind: 'community', source: 'hn', sourceName: 'Hacker News', discussUrl: `https://news.ycombinator.com/item?id=${best.objectID}`, heat: {hnPoints: best.points || 0, hnComments: best.num_comments || 0}});
    } catch {}
  });
  candidates.sort((a, b) => b.heat.score - a.heat.score);
  candidates.forEach((c, i) => c.key = 'k' + (i + 1));
  log(`HN 讨论：${candidates.length} 个候选项目里 ${hit} 个这周在 HN 上被发过`);
  return candidates;
}

// ---------- 项目资料（enrich 阶段）----------
const ghHeaders = () => ({accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? {authorization: `Bearer ${process.env.GITHUB_TOKEN}`} : {})});

/** GitHub API 拿仓库信息和 README（不登录每小时 60 次，一期 3～6 个项目够用）。 */
export async function repoInfo(repo) {
  const j = await fetchJson(`https://api.github.com/repos/${repo}`, {headers: ghHeaders(), timeoutMs: 15000});
  const info = {fullName: j.full_name, url: j.html_url, description: j.description || '', stars: j.stargazers_count || 0, forks: j.forks_count || 0, language: j.language || '',
    topics: (j.topics || []).slice(0, 8), homepage: j.homepage || '', license: j.license?.spdx_id && j.license.spdx_id !== 'NOASSERTION' ? j.license.spdx_id : '', createdAt: j.created_at, pushedAt: j.pushed_at, branch: j.default_branch || 'main', owner: j.owner?.login, ownerType: j.owner?.type};
  try {
    const {text} = await fetchText(`https://api.github.com/repos/${repo}/readme`, {headers: {...ghHeaders(), accept: 'application/vnd.github.raw'}, timeoutMs: 15000, maxBytes: 3 * 1024 * 1024});
    info.readmeRaw = text;
  } catch (e) { info.readmeError = e.message; }
  return info;
}

/** README 里的图（产品截图、演示动图），相对路径换成 raw.githubusercontent.com；徽章、图标、svg 不要。 */
export function readmeImages(md, {fullName, branch}) {
  const out = [];
  const urls = [...String(md).matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g), ...String(md).matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => ({u: m[1], at: m.index})).sort((a, b) => a.at - b.at).map(x => x.u);
  for (let u of urls) {
    if (/shields\.io|badge|badgen|\/actions\/workflows|codecov|travis-ci|circleci|star-history|api\.star|contrib\.rocks|readme-typing|visitor|hits\.|logo|icon|emoji|avatar|sponsor|ko-fi|buymeacoffee|patreon|paypal|opencollective|afdian|discord|wechat|qrcode|qr_code|qr-code|\.svg(\?|$)/i.test(u)) continue;
    if (u.startsWith('data:')) continue;
    if (!/^https?:/i.test(u)) u = `https://raw.githubusercontent.com/${fullName}/${branch}/${u.replace(/^\.?\//, '')}`;
    u = u.replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:blob|raw)\/(.+)$/i, 'https://raw.githubusercontent.com/$1/$2');
    if (!out.includes(u)) out.push(u);
    if (out.length >= 6) break;
  }
  return out;
}

/** README 变成给写稿用的纯文字：去掉徽章、图片、HTML、代码块缩短。 */
export function readmeText(md, max = 6000) {
  return String(md || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, m => m.split('\n').slice(0, 6).join('\n') + (m.split('\n').length > 6 ? '\n…\n```' : ''))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/<img[^>]*>/gi, '').replace(/<\/?(p|div|a|picture|source|br|h\d|details|summary|sup|sub|b|strong|em|span|table|tr|td|th|tbody|thead)[^>]*>/gi, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, max);
}

/** 12345 → 1.2万；本周涨星这类小数字保留原样 */
export const fmtStars = n => !n ? '0' : n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '')}万` : n >= 1000 ? n.toLocaleString('en-US') : String(n);
