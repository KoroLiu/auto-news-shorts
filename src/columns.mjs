// 板块（栏目）：每日 AI 要闻、每周 GitHub 项目……流程一样，各自一套来源、选题规则、条数、标题。设置在 config.json 的 columns。
// Episode folders are named runs/<date>-<runSuffix>, e.g. runs/2026-01-31-news. Old suffixes can be listed in legacySuffixes;
// a folder with no suffix (runs/<date>) counts as the default column.
import fs from 'node:fs';
import path from 'node:path';
import {ROOT, dateParts} from './util.mjs';
import {CHAPTERS} from './rank.mjs';

export const DEFAULT_COLUMN = 'news';

export function columnList(cfg) {
  return Object.entries(cfg.columns || {}).filter(([k]) => !k.startsWith('_')).map(([id, c]) => ({id, ...c}));
}

/** 按 id 或期数文件夹名找板块；找不到就用要闻（兼容以前的期）。 */
export function getColumn(cfg, {id, run} = {}) {
  const list = columnList(cfg);
  let col = id && list.find(c => c.id === id);
  if (!col && run) { try { const saved = JSON.parse(fs.readFileSync(path.join(ROOT, 'runs', run, 'column.json'), 'utf8')).id; col = list.find(c => c.id === saved); } catch {} }
  if (!col && run) col = list.find(c => suffixesOf(c).some(x => run.slice(10).startsWith('-' + x)));
  // Folder without a column suffix: use the legacy single-column settings (7 chapters, all sources)
  if (!col && run) return {id: DEFAULT_COLUMN, legacy: true, name: cfg.channel?.name || '每日AI资讯', titleTag: cfg.channel?.name || '每日AI资讯', chapters: CHAPTERS, stories: cfg.video?.stories || {min: 14, max: 22}, sources: null, rules: null};
  col = col || list.find(c => c.id === DEFAULT_COLUMN) || list[0];
  if (!col) throw new Error('config.json 里没有 columns（板块）设置');
  return {chapters: [col.name], stories: {min: 5, max: 8}, ...col};
}

export const runNameFor = (col, iso) => col.runSuffix ? `${iso}-${col.runSuffix}` : iso;
const suffixesOf = col => [col.runSuffix, ...(col.legacySuffixes || [])].filter(Boolean);
/** 这个板块某天可能有的期数文件夹：现在的后缀、改名前的后缀（如「要闻」），每日板块还有没后缀的旧期。 */
const runNamesFor = (col, iso) => [...suffixesOf(col).map(x => `${iso}-${x}`), ...(col.id === DEFAULT_COLUMN ? [iso] : [])];

/** 这个板块用哪些来源：按 col.sources 开关；X 账号去掉 col.excludeAccounts 里的；col.sourceOptions 可以改某个来源的设置（如 GitHub 板块让 HN、Reddit 看一周）。 */
export function columnSources(col, sources) {
  return sources.map(s => ({...s, ...(col.sourceOptions?.[s.id] || {})})).map(s => {
    const on = !col.sources || col.sources.includes(s.id);
    if (s.type === 'x_accounts' && col.excludeAccounts?.length) {
      const ex = new Set(col.excludeAccounts.map(h => h.toLowerCase()));
      return {...s, enabled: on && s.enabled !== false, accounts: (s.accounts || []).filter(a => !ex.has(String(a.handle || a).toLowerCase()))};
    }
    return {...s, enabled: on && s.enabled !== false};
  });
}

/** 同一板块之前做完的几期（有 stories-written.json），新的在前；按期数往前找，不按日历。
 * Earlier episodes of the same day count too; current = this episode's own folder name. */
export function previousEpisodes(col, iso, {current = runNameFor(col, iso), episodes = 3, lookbackDays = 60} = {}) {
  const out = [];
  const collectedAt = e => { try { return fs.statSync(path.join(e.dir, 'candidates.json')).mtimeMs; } catch { return 0; } };
  for (let i = 0; i <= lookbackDays && out.length < episodes; i++) {
    const d = dateParts(new Date(new Date(iso + 'T12:00:00+08:00').getTime() - i * 86400000)).iso;
    const found = runNamesFor(col, d).filter(n => n !== current).map(name => ({name, iso: d, dir: path.join(ROOT, 'runs', name)}))
      .filter(e => fs.existsSync(path.join(e.dir, 'stories-written.json')));
    out.push(...found.map(e => ({...e, collectedAt: collectedAt(e)})).sort((a, b) => b.collectedAt - a.collectedAt)); // 同一天好几期：后采集的在前
  }
  return out.slice(0, episodes);
}

const storiesOf = e => { try { return JSON.parse(fs.readFileSync(path.join(e.dir, 'stories-written.json'), 'utf8').replace(/^﻿/, '')); } catch { return []; } };

/** 同一板块最近几期播过的标题，给选题时避免重复。 */
export function recentColumnTitles(col, iso, opts = {}) {
  return previousEpisodes(col, iso, opts).flatMap(e => storiesOf(e).map(s => `${e.iso} ${s.title}`));
}

/** 网址比对用：去掉 http、www、结尾斜杠（X 推文再去掉 ?s= 之类参数）；只剩首页的返回空，不拿来比。 */
export function urlKey(u) {
  try {
    const x = new URL(u), host = x.hostname.replace(/^www\./, ''), p = x.pathname.replace(/\/+$/, '');
    return p ? host + p + (/^(x|twitter)\.com$/.test(host) ? '' : x.search) : '';
  } catch { return ''; }
}

/** 某一期讲过的新闻用到的所有网址（候选原文、来源链接），给下一期硬性去重。 */
export function episodeUrls(e) {
  const set = new Set();
  for (const s of storiesOf(e))
    for (const u of [s.url, s.primary?.url, ...(s.items || []).map(i => i.url), ...(s.sources || []).map(i => i.url)]) { const n = u && urlKey(u); if (n) set.add(n); }
  return set;
}
