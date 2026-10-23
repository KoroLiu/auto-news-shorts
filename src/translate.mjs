// 候选新闻的中文翻译（工作台「中英对照」用）：免费的网页翻译接口，不占 AI 额度、不用注册。
// 主用 Bing 网页翻译（国内直连可用、质量好），Bing 不行时改用谷歌网页翻译（要开代理）。
// 结果存在每期的 translations.json（{英文原文: 中文}）。翻不了的只显示英文，这里绝不抛错，不能让采集或选题失败。
import path from 'node:path';
import {readJson, writeJson, log} from './util.mjs';

export const TR_FILE = 'translations.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
// 工作台摘要只显示前 240 个字，翻译也只翻这一段（省时间，中英能对上）
export const summaryText = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 240);
const needs = s => s && /[A-Za-z]{3}/.test(s) && !/[一-鿿]{2}/.test(s); // 已经是中文的不翻

export async function loadTranslations(dir) { return (await readJson(path.join(dir, TR_FILE), {})).map || {}; }
// 工作台用：给一条候选新闻配上中文（没有就是空）
export const zhOf = (map, item) => ({titleZh: map[item.title] || '', summaryZh: map[summaryText(item.summary)] || ''});

// ---- Bing 网页翻译：先打开翻译页拿到临时令牌（约 1 小时有效），每次最多 1000 字 ----
let bing = null;
async function bingSession() {
  if (bing && Date.now() - bing.at < 50 * 60 * 1000) return bing;
  const r = await fetch('https://www.bing.com/translator', {headers: {'user-agent': UA}, signal: AbortSignal.timeout(15000)});
  const h = await r.text();
  const IG = h.match(/IG:"([^"]+)"/)?.[1], iid = h.match(/data-iid="([^"]+)"/)?.[1], m = h.match(/params_AbusePreventionHelper\s*=\s*\[(\d+),"([^"]+)"/);
  if (!IG || !iid || !m) throw new Error('Bing 翻译页面变了，拿不到令牌');
  bing = {at: Date.now(), host: new URL(r.url).origin, IG, iid, key: m[1], token: m[2], n: 0, cookie: r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')};
  return bing;
}
async function bingTranslate(text) {
  const s = await bingSession();
  const r = await fetch(`${s.host}/ttranslatev3?isVertical=1&IG=${s.IG}&IID=${s.iid}.${++s.n}`, {method: 'POST', signal: AbortSignal.timeout(20000),
    headers: {'content-type': 'application/x-www-form-urlencoded', cookie: s.cookie, 'user-agent': UA, referer: s.host + '/translator'},
    body: new URLSearchParams({fromLang: 'auto-detect', to: 'zh-Hans', text, key: s.key, token: s.token})});
  const j = await r.json().catch(() => null);
  const out = Array.isArray(j) && j[0]?.translations?.[0]?.text;
  if (!out) { if (j?.statusCode === 205 || r.status === 429) bing = null; throw new Error(`Bing 翻译失败（${r.status} ${JSON.stringify(j).slice(0, 80)}）`); }
  return out;
}
// ---- 谷歌网页翻译（translate.googleapis.com，client=gtx）：要代理，一次最多约 5000 字 ----
async function googleTranslate(text) {
  const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t', {method: 'POST', body: new URLSearchParams({q: text}), headers: {'user-agent': UA}, signal: AbortSignal.timeout(20000)});
  if (!r.ok) throw new Error(`谷歌翻译失败（HTTP ${r.status}）`);
  const j = await r.json();
  return (j?.[0] || []).map(x => x[0] || '').join('');
}
const PROVIDERS = [{name: 'Bing', fn: bingTranslate, max: 950}, {name: '谷歌', fn: googleTranslate, max: 3800}];

// 把多条短文本用换行拼成一次请求；回来的行数对不上就一条条单独翻
async function translateChunk(p, list) {
  if (list.length === 1) return [(await p.fn(list[0])).trim()];
  const lines = (await p.fn(list.join('\n'))).split(/\n+/).map(x => x.trim()).filter(Boolean);
  if (lines.length === list.length) return lines;
  const out = []; for (const t of list) out.push((await p.fn(t)).trim()); return out;
}
function chunksOf(list, max) {
  const out = []; let cur = [], len = 0;
  for (const t of list) { if (cur.length && len + t.length + 1 > max) { out.push(cur); cur = []; len = 0; } cur.push(t.slice(0, max)); len += t.length + 1; }
  if (cur.length) out.push(cur); return out;
}

// 翻译一期的全部候选（只翻还没翻过的）。返回 {total, done, failed, provider, ms}
const running = new Map();
export function translateRun(dir, opts) {
  if (!running.has(dir)) running.set(dir, doTranslate(dir, opts).finally(() => running.delete(dir)));
  return running.get(dir);
}
async function doTranslate(dir, {concurrency = 6, deadlineMs = 150000} = {}) {
  const t0 = Date.now();
  try {
    const items = await readJson(path.join(dir, 'candidates.json'), []);
    const file = path.join(dir, TR_FILE);
    const map = (await readJson(file, {})).map || {};
    const todo = [...new Set(items.filter(i => i.lang !== 'zh').flatMap(i => [i.title, summaryText(i.summary)]).filter(t => needs(t) && !map[t]))];
    if (!todo.length) return {total: 0, done: 0, failed: 0, provider: '', ms: 0};
    let pi = 0, done = 0, failed = 0, used = new Set(), lastErr = '';
    const queue = chunksOf(todo, PROVIDERS[0].max);
    const worker = async () => {
      for (let c; (c = queue.shift());) {
        if (Date.now() - t0 > deadlineMs) { failed += c.length; continue; }
        for (let tries = 0; ; tries++) {
          const p = PROVIDERS[pi];
          if (!p) { failed += c.length; break; }
          try { const zh = await translateChunk(p, c); c.forEach((t, k) => { if (zh[k]) map[t] = zh[k]; }); done += c.length; used.add(p.name); break; }
          catch (e) { lastErr = e.message; if (tries >= 1 && PROVIDERS[pi] === p) { log(`翻译：${p.name} 不可用（${e.message}），改用下一个`); pi++; } }
        }
      }
    };
    await Promise.all(Array.from({length: concurrency}, worker));
    await writeJson(file, {updatedAt: new Date().toISOString(), provider: [...used].join('+'), map});
    const res = {total: todo.length, done, failed, provider: [...used].join('+'), ms: Date.now() - t0};
    log(`翻译完成：${done}/${todo.length} 段，用 ${res.provider || '无'}，${Math.round(res.ms / 1000)} 秒${failed ? `（${failed} 段没翻成，只显示英文${lastErr ? '：' + lastErr : ''}）` : ''}`);
    return res;
  } catch (e) {
    log('翻译出错（不影响采集和选题，候选只显示英文）：' + e.message);
    return {total: 0, done: 0, failed: 0, provider: '', ms: Date.now() - t0, error: e.message};
  }
}
