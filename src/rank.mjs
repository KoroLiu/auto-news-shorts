// Event clustering + heat scoring + LLM editor selection ("what is actually hot today").
import fs from 'node:fs';
import path from 'node:path';
import {askJson} from './llm.mjs';
import {writeJson, log} from './util.mjs';
import {POLITICS_RULE, markPolitics} from './politics.mjs';

export const CHAPTERS = ['要闻', '模型发布', '产品应用', '开发生态', '技术与洞察', '行业动态', '前瞻与传闻'];

const STOP = new Set('the a an of to in for on and with is are by at from as its it this that new how why what you your our we be was will can now into out over up more than via about after before his her their they has have had not just vs'.split(' '));
function tokens(title) {
  const s = String(title).toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/^@\w+[：:]/, ' ');
  const t = new Set();
  for (const w of s.match(/[a-z0-9][a-z0-9.\-+]*[a-z0-9]|[a-z0-9]/g) || []) if (!STOP.has(w) && w.length > 1) t.add(w);
  const cjk = (s.match(/[㐀-鿿]+/g) || []).join('|');
  for (let i = 0; i < cjk.length - 1; i++) { const bg = cjk.slice(i, i + 2); if (!bg.includes('|')) t.add(bg); }
  return t;
}
function entities(title) {
  const e = new Set();
  for (const w of String(title).match(/[A-Z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*|[A-Za-z]+-?\d+(?:\.\d+)?/g) || []) if (w.length > 1 && !/^(The|A|An|In|On|For|With|How|Why|What|New|And|To|Of|Is|AI)$/.test(w)) e.add(w.toLowerCase());
  for (const w of String(title).match(/OpenAI|Anthropic|Claude|Gemini|DeepSeek|Qwen|千问|通义|豆包|字节|腾讯|混元|阿里|百度|文心|智谱|GLM|Kimi|月之暗面|MiniMax|英伟达|NVIDIA|苹果|Apple|谷歌|Google|微软|Microsoft|Meta|xAI|Grok|Mistral|Perplexity|Cursor|Codex|ChatGPT|Sora|小米|华为|阶跃|商汤|讯飞|美团|快手|可灵/gi) || []) e.add(w.toLowerCase().replace('谷歌', 'google').replace('微软', 'microsoft').replace('英伟达', 'nvidia').replace('苹果', 'apple'));
  return e;
}
const jacc = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / Math.max(1, a.size + b.size - n); };

// 「品牌+版本号」：Kimi K3.1 / Kimi3.1 → kimi:3.1，Qwen4 → qwen:4。同一个新模型各家叫法不同、标题用词也不同，光按词重合连不起来
// （10-23 Kimi K3.1 的 IT之家报道、Reddit 帖、官方预热帖三处各算各的，热度被拆散，IT之家那条还在交给 AI 前就被筛掉了）
const MODEL_RE = /\b(kimi|qwen|deepseek|glm|minimax|gpt|claude|gemini|gemma|llama|grok|mimo|hunyuan|doubao|kling|sora|veo|ernie|mistral|opus|sonnet|haiku)[\s-]*[a-z]?(\d+(?:\.\d+)?)/gi;
export function modelKeys(title) {
  const keys = new Set();
  for (const m of String(title).replace(/https?:\/\/\S+/g, ' ').matchAll(MODEL_RE)) keys.add(m[1].toLowerCase() + ':' + m[2]);
  return keys;
}
/** 官方推文只有链接（图片、视频），没有文字：AI 看不懂内容，聚类也连不上 */
export const isBareTweet = i => !!i.tweet && String(i.tweet.text || '').replace(/https?:\/\/\S+/g, '').replace(/RT @\w+:?/, '').trim().length < 8;

export function cluster(items) {
  const parent = items.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const tk = items.map(i => tokens(i.title)), en = items.map(i => entities(i.title)), mk = items.map(i => modelKeys(i.title));
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    if (items[i].isDigest || items[j].isDigest) continue;
    // 同一个「品牌+版本号」、其中一条是新闻网站的报道，就算同一件事。官方号、测评号天天提自家现役模型（如 Opus 5.5），
    // 所以要有媒体报道兜着才连；一条标题里有 3 个以上型号的（排行榜、对比）不当连接点
    if (mk[i].size && mk[j].size && mk[i].size <= 2 && mk[j].size <= 2 && (items[i].kind === 'media' || items[j].kind === 'media') && [...mk[i]].some(k => mk[j].has(k))) { parent[find(i)] = find(j); continue; }
    if (tk[i].size < 3 || tk[j].size < 3) continue;
    const jac = jacc(tk[i], tk[j]);
    let shared = 0; for (const x of en[i]) if (en[j].has(x)) shared++;
    if (jac >= .5 || (shared >= 2 && jac >= .22) || (shared >= 1 && jac >= .38)) parent[find(i)] = find(j);
  }
  // 只有链接的官方推文（多半是新模型预热视频）：并进同一家公司、带版本号的报道那组里
  for (let i = 0; i < items.length; i++) {
    if (!isBareTweet(items[i]) || items[i].kind !== 'official') continue;
    const brands = entities(items[i].tweet.handle || '');
    const mates = items.map((it, j) => j).filter(j => j !== i && find(j) !== find(i) && [...mk[j]].some(k => brands.has(k.split(':')[0])));
    if (mates.length) parent[find(i)] = find(mates[0]);
  }
  const groups = new Map();
  items.forEach((it, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(it); });
  return [...groups.values()];
}

export function heatOf(group, now = Date.now()) {
  const h = {hnPoints: 0, hnComments: 0, redditScore: 0, ghStarsToday: 0, hfLikes: 0, paperUpvotes: 0, hfTrendingRank: 0, weiboRank: 0, xLikes: 0, xRetweets: 0, xViews: 0};
  for (const it of group) for (const [k, v] of Object.entries(it.heat || {})) {
    if (k.endsWith('Rank')) h[k] = h[k] ? Math.min(h[k], v) : v; else h[k] = Math.max(h[k] || 0, v || 0);
  }
  const sources = new Set(group.flatMap(i => i.seenIn || [i.source]));
  const kinds = new Set(group.map(i => i.kind));
  const media = group.filter(i => i.kind === 'media').length;
  const zhMedia = group.filter(i => i.kind === 'media' && i.lang === 'zh').length;
  const official = kinds.has('official');
  const newest = Math.min(...group.map(i => i.date ? (now - new Date(i.date)) / 3.6e6 : 12));
  let s = 12 * Math.log10(1 + h.hnPoints) + 4 * Math.log10(1 + h.hnComments) + 10 * Math.log10(1 + h.redditScore) + 10 * Math.log10(1 + h.ghStarsToday)
    + (h.hfTrendingRank ? Math.max(0, 22 - h.hfTrendingRank * .5) : 0) + 5 * Math.log10(1 + h.hfLikes) + 6 * Math.log10(1 + h.paperUpvotes)
    + (h.weiboRank ? Math.max(0, 32 - h.weiboRank * .5) : 0) + 9 * Math.log10(1 + h.xLikes) + 3 * Math.log10(1 + h.xRetweets) + (group.some(i => i.tweet && i.kind === 'official') ? 14 : 0)
    + 9 * (sources.size - 1) + 5 * media + (official ? 10 : 0) + (sources.has('techmeme') ? 12 : 0) + Math.max(0, 10 - newest / 3); // no extra weight for Chinese-language media
  if (group.every(i => i.kind === 'release')) s -= 8; // routine version bumps
  // 新闻网站在报某个带版本号的模型：新模型是必追热点，但媒体文章没有点赞数，热度天生偏低（10-23 Kimi K3.1 只有 14 分）
  if (group.some(i => i.kind === 'media' && modelKeys(i.title).size)) s += 8;
  return {score: Math.round(s * 10) / 10, sources: [...sources], official, media, zhMedia, hoursAgo: Math.round(newest), ...h};
}

function heatText(x) {
  const p = [];
  if (x.xLikes || x.xViews) p.push(`X ${x.xLikes}赞${x.xViews ? '/' + x.xViews + '浏览' : ''}`);
  if (x.hnPoints) p.push(`HN ${x.hnPoints}分/${x.hnComments}评`);
  if (x.redditScore) p.push(`Reddit ${x.redditScore}赞`);
  if (x.ghStarsWeek) p.push(`GitHub 本周+${x.ghStarsWeek}星`);
  if (x.ghTrendingDays) p.push(`这周上每日热榜${x.ghTrendingDays}天`);
  if (x.ghStarsToday) p.push(`GitHub ${x.ghTrendingDays ? '单日最多' : '今日'}+${x.ghStarsToday}星`);
  if (x.ghStars && (x.ghStarsWeek || x.ghTrendingDays)) p.push(`总${x.ghStars}星`);
  if (x.hfTrendingRank) p.push(`HF热门#${x.hfTrendingRank}`);
  if (x.paperUpvotes) p.push(`论文${x.paperUpvotes}赞`);
  if (x.weiboRank) p.push(`微博热搜#${x.weiboRank}`);
  if (x.media) p.push(`媒体${x.media}家`);
  if (x.official) p.push('官方');
  p.push(`${x.sources.length}个来源`);
  if (!x.noAge) p.push(`${x.hoursAgo}小时前`);
  return p.join('，');
}

// ---------- 非 AI 的科技大事（columns.news.nonAI）----------
// 采集时和 AI 无关、但来自综合科技来源的新闻标了 nonAI。不同网站标题写法差很多（「eMudhra 私钥泄露」「8 张 TLS 证书出事」），
// 光按标题聚类连不起来，所以再看：共享非大牌专有名词（PHP、eMudhra 这种），而且至少有两个相同的词，才连起来。
// Apple、iPhone 和 Pro 这类大牌名、通用产品词不能当连接点，免得不同新闻一个传一个连成大组。
const BIG_HN = 600; // 只有 HN 一个来源时，至少要这么多分才算全网级（400 分会放进不少随笔、科普）
const BROAD_NAMES = new Set('apple iphone phone ipad pad google microsoft meta amazon samsung android ios windows chrome 苹果 谷歌 微软 三星 app store pro inc games'.split(' '));
function properNames(title) {
  // Epic 这类名字也可能在标题开头；只排除常见句首词，不一律扔掉首词。
  return new Set([...entities(title)].filter(e => e.length >= 3 && !STOP.has(e) && !/^(sources?|reports?|today|potential|upcoming|critical)$/.test(e) && !BROAD_NAMES.has(e)));
}
/** 非 AI 的条目按同一件事分组。 */
export function nonAiGroups(items) {
  const non = items.filter(i => i.nonAI && !i.isDigest);
  const names = non.map(i => properNames(i.title)), tk = non.map(i => tokens(i.title));
  const parent = non.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < non.length; i++) for (let j = i + 1; j < non.length; j++) {
    let common = 0; for (const x of tk[i]) if (tk[j].has(x)) common++;
    if (common >= 2 && [...names[i]].some(e => names[j].has(e))) parent[find(i)] = find(j);
  }
  const groups = new Map();
  non.forEach((it, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(it); });
  return [...groups.values()];
}
/** 够「全网级」苗头的非 AI 事件：2 个以上来源在报，或上了 Techmeme，或 HN 600 分以上。 */
export const isBigTech = g => new Set(g.flatMap(i => i.seenIn || [i.source])).size >= 2 || g.some(i => i.source === 'techmeme' || (i.seenIn || []).includes('techmeme')) || g.some(i => (i.heat?.hnPoints || 0) >= BIG_HN);

export function buildCandidates(items, {max = 170, nonAiMax = 0, now = Date.now()} = {}) {
  const digests = items.filter(i => i.isDigest);
  const groups = cluster(items.filter(i => !i.isDigest && !i.nonAI)).map(g => ({items: g, heat: heatOf(g, now)}));
  groups.sort((a, b) => b.heat.score - a.heat.score);
  // keep diversity: always include top items per source kind
  const chosen = new Set(groups.slice(0, Math.floor(max * .75)));
  // 每类来源保底几个名额；媒体文章没有点赞数据、热度天生偏低，多给一些（10-23 从 12 提到 25）
  for (const kind of ['official', 'media', 'community', 'trending', 'aggregator']) groups.filter(g => g.items.some(i => i.kind === kind)).slice(0, kind === 'media' ? 25 : 12).forEach(g => chosen.add(g));
  const list = groups.filter(g => chosen.has(g)).slice(0, max);
  // 非 AI 的科技大事另算名额、排在 AI 候选后面，不挤占 AI 新闻：来源多的在前，再看热度
  const extra = nonAiMax ? nonAiGroups(items).filter(isBigTech).map(g => ({items: g, heat: heatOf(g, now), nonAI: true}))
    .sort((a, b) => b.heat.sources.length - a.heat.sources.length || b.heat.score - a.heat.score).slice(0, nonAiMax) : [];
  return {candidates: [...list, ...extra].map((g, i) => ({key: 'k' + (i + 1), ...g})), digests};
}

const selectionSchema = (chapters, nonAI = false) => ({
  type: 'object', additionalProperties: false, required: ['stories', 'notes', 'skippedHot'],
  properties: {
    notes: {type: 'string'},
    skippedHot: {type: 'array', items: {type: 'object', additionalProperties: false, required: ['key', 'why'], properties: {key: {type: 'string'}, why: {type: 'string'}}}},
    stories: {type: 'array', items: {type: 'object', additionalProperties: false, required: ['keys', 'chapter', 'workingTitle', 'importance', 'reason', 'politics', 'politicsWhy', ...(nonAI ? ['nonAI', 'aiAngle'] : [])],
      properties: {keys: {type: 'array', items: {type: 'string'}}, chapter: {type: 'string', enum: chapters}, workingTitle: {type: 'string'}, importance: {type: 'integer'}, reason: {type: 'string'}, politics: {type: 'string', enum: ['none', 'unsure', 'yes']}, politicsWhy: {type: 'string'}, ...(nonAI ? {nonAI: {type: 'boolean'}, aiAngle: {type: 'string'}} : {})}}},
  },
});

export async function selectStories({candidates, digests, cfg, date, workDir, history = [], col = null}) {
  // col = 板块（columns.mjs）；没有时用老的 7 个栏目（兼容）
  const chapters = col?.chapters?.length ? col.chapters : CHAPTERS;
  const single = chapters.length === 1;
  const target = col?.stories || cfg.video?.stories || {min: 14, max: 22};
  // 热度排名（程序算的，非 AI 科技另算不排）：给 AI 看，也用来要求它说明热度前 10 为什么不选
  const rankOf = new Map(candidates.filter(c => !c.nonAI).sort((a, b) => b.heat.score - a.heat.score).map((c, i) => [c.key, i + 1]));
  const lines = candidates.map(c => {
    const main = c.items.slice().sort((a, b) => (b.kind === 'official') - (a.kind === 'official'))[0];
    // 只有链接的推文标题是一串网址，换成说明，免得 AI 以为是空帖
    const titles = [...new Set(c.items.map(i => isBareTweet(i) ? `${i.sourceName}：〔只发了图片/视频/链接，没有文字；这是官方号的帖子，看同组其他报道判断内容〕` : i.title))].slice(0, 3).join(' ‖ ');
    const sum = (c.items.find(i => i.summary && !isBareTweet(i))?.summary || '').replace(/\s+/g, ' ').slice(0, 160);
    const rank = rankOf.get(c.key);
    return `[${c.key}]${c.nonAI ? '〔非AI科技〕' : ''} ${titles}\n    热度：${rank ? `第${rank}名（${c.heat.score}分），` : ''}${heatText(c.heat)}；来源：${[...new Set(c.items.map(i => i.sourceName))].slice(0, 4).join('/')}；${main.url}${sum ? `\n    摘要：${sum}` : ''}`;
  }).join('\n');
  const digestText = digests.map(d => `《${d.title}》\n${(d.digestText || d.summary).slice(0, 5000)}`).join('\n\n');
  const show = col?.name || '中文 AI 科技日报';
  const rules = col?.rules ? `${col.rules}\n${history.length ? '最近几期已经播过的内容见下方“已播列表”，不要重复。' : ''}` : null;
  const prompt = `你是一档中文 AI 科技视频节目「${show}」（B站，面向关注 AI 的普通用户和开发者）的主编。今天是 ${date}。
${col?.mode === 'github' ? '下面是这一周的候选 GitHub 项目（每个候选就是一个仓库，程序已经把 GitHub 本周热榜、每日热榜、Hacker News、Reddit、博客里提到同一个仓库的合在一起；最近几周已经讲过的项目程序已经去掉了），附热度信号：本周涨星、这周上每日热榜几天、单日最多涨星、总星数、HN 分数、Reddit 赞数、被几个来源提到。' : '下面是程序从几十个来源抓到的候选事件（已按标题初步聚类；其中以“@账号：”开头的是各家 AI 公司官方 X/推特账号的最新帖子，这是最重要的一手消息来源；并附上热度信号：X 点赞、HN 分数、Reddit 赞数、GitHub 今日星标、Hugging Face 热门、微博热搜、多少家媒体报道、是否官方发布、距今多少小时）。'}

你的任务：挑出真正值得播报的 ${target.min}–${target.max} 条${single ? '' : '，并分到栏目'}。${target.hardMax > target.max ? `宁缺毋滥：只有排在后面的那条也确实非常重要、非常热时，才可以放宽到最多 ${target.hardMax} 条；凑数的条目会拖累短视频的完播率。` : ''}

${rules ? `${rules}
${!col?.sources || col.sources.includes('x') ? '【X 帖子】官方账号发的新模型、新功能、价格变化、重要合作通常就是头条；转推、日常互动、活动预告、招聘、纯宣传口号要排除。\n' : ''}【栏目】只有一个：「${chapters[0]}」，chapter 一律填「${chapters[0]}」。
【合并】同一事件的多个候选（包括中英文不同报道）请把它们的 key 都放进同一条的 keys，主信息源（官方原文优先）放第一个。
【排序】stories 数组按播出顺序，最重要的放最前面。importance 用 1–10 打分。
workingTitle ${col?.titleRule || '用一句中文概括（像新闻标题，20 字以内，例如“OpenAI 上线 ChatGPT Slides”）'}。reason 用一句话说明入选理由（热度证据）。
notes 写一句整体概况。
` : ''}
${rules ? '' : `【判断“热点”的标准，按优先级】
1. 大事件：头部公司（OpenAI、Google、Anthropic、Meta、xAI、微软、英伟达、苹果，以及 DeepSeek、阿里通义千问、字节豆包/Seed、腾讯混元、智谱、Kimi、MiniMax 等）的新模型、重要产品发布、价格/额度大调整、大额融资并购、重要人事变动、安全事故。
2. 多源共振：被多家媒体/社区同时报道、HN/Reddit 高分、微博热搜上榜、GitHub/HF 当天爆火的开源项目和模型——这些就是“大家都在聊”的热点。
3. 与中文观众相关：国内大模型和产品动态、国内用户能用到的工具变化，要有足够比例（建议 30% 以上）。
4. 对开发者有用的重要更新（主流编程工具/Agent 工具的重大功能，而不是普通补丁版本）。
【关于 X 帖子】官方账号发的新模型、新功能、价格变化、重要合作通常就是当天头条，优先考虑；转推、日常互动、活动预告、招聘、纯宣传口号要排除；个人/爆料账号的内容只能作为“前瞻与传闻”或用来判断热度。
【必须排除】小版本号补丁（如 x.y.z 修复若干 bug）、营销软文、招聘、教程、个人博客观点、与 AI 无关的内容、和已选条目重复的同一事件、明显超过 48 小时的旧闻${history.length ? '、最近几期已经播过的内容（见下方“已播列表”）' : ''}。论文最多 2 篇，且只选热度很高的。
【栏目】${CHAPTERS.join('、')}。“要闻”放当天最重要的 3–5 条（不论类型）；其余按内容归类；“前瞻与传闻”只放有可靠媒体来源的爆料/传闻（标注为传闻）。
【合并】同一事件的多个候选（包括中英文不同报道）请把它们的 key 都放进同一条的 keys，主信息源（官方原文优先）放第一个。
【排序】stories 数组按播出顺序：先“要闻”，再按栏目顺序；栏目内按重要性降序。importance 用 1–10 打分。
workingTitle 用一句中文概括（像新闻标题，20 字以内，例如“OpenAI 上线 ChatGPT Slides”）。reason 用一句话说明入选理由（热度证据）。
notes 写一句今天整体热点概况。
`}
${POLITICS_RULE}

【热度排名】每个候选都标了程序算的热度排名（看点赞、评论、媒体家数、来源数、新旧）。热度前 10 名的事件默认值得播；你没选的，必须在 skippedHot 里逐个写一句为什么不选（key + why，例：「和 k3 是同一件事」「只是活动照片」「离观众太远」）。热度 30 名以后的入选，reason 里要写清它凭什么压过更热的。

${digestText ? `【热度参考：海外 AI 社区日报摘要（可帮助判断推特/Reddit 上在热议什么，但只能选候选列表里有的事件）】\n${digestText}\n\n` : ''}${history.length ? `【已播列表（最近几期，避免重复）】\n${history.join('\n')}\n\n` : ''}【候选事件】
${lines}`;
  const nonAiMax = col?.nonAI ? col.nonAI.max ?? 1 : null; // 每期最多几条非 AI 的科技大事
  const res = await askJson(prompt, selectionSchema(chapters, nonAiMax !== null), {cfg, workDir, label: '选题'});
  const byKey = new Map(candidates.map(c => [c.key, c]));
  const used = new Set();
  const stories = [];
  for (const s of res.stories || []) {
    const keys = (s.keys || []).filter(k => byKey.has(k) && !used.has(k));
    if (!keys.length) continue; keys.forEach(k => used.add(k));
    const items = keys.flatMap(k => byKey.get(k).items);
    stories.push({id: 's' + (stories.length + 1), ...(byKey.get(keys[0]).repo ? {repo: byKey.get(keys[0]).repo} : {}), chapter: chapters.includes(s.chapter) ? s.chapter : chapters[chapters.length - 1], workingTitle: s.workingTitle, importance: s.importance, reason: s.reason, ...(nonAiMax !== null && (s.nonAI === true || items.every(i => i.nonAI)) ? {nonAI: true, aiAngle: String(s.aiAngle || '').trim()} : {}), items, heat: byKey.get(keys[0]).heat});
    const pol = markPolitics(stories[stories.length - 1], s); // 涉及政治或拿不准的，main.mjs 会停在选题审核
    if (pol) stories[stories.length - 1].politics = pol;
  }
  // 非 AI 的科技大事：程序再把一道关——最多 nonAiMax 条（留重要性高的）；讲得出和 AI 关系（aiAngle）的按 AI 主编排的位置播，讲不出的放到最后
  if (nonAiMax !== null) {
    const drop = new Set(stories.filter(s => s.nonAI).sort((a, b) => b.importance - a.importance).slice(nonAiMax));
    if (drop.size) log(`非 AI 科技新闻选多了，只留 ${nonAiMax} 条，去掉：${[...drop].map(s => s.workingTitle).join('、')}`);
    const kept = stories.filter(s => !drop.has(s)), last = kept.filter(s => s.nonAI && !s.aiAngle);
    stories.splice(0, stories.length, ...kept.filter(s => !last.includes(s)), ...last);
  }
  // keep chapter order stable
  if (!single) stories.sort((a, b) => chapters.indexOf(a.chapter) - chapters.indexOf(b.chapter));
  stories.forEach((s, i) => s.id = 's' + (i + 1));
  if (workDir) await writeJson(path.join(workDir, '..', 'selection.json'), {notes: res.notes, stories: stories.map(s => ({...s, items: s.items.map(i => ({title: i.title, url: i.url, source: i.sourceName, kind: i.kind, date: i.date}))}))});
  log(`选题完成：${stories.length} 条。${res.notes || ''}`);
  // Heat ranking: top 20, whether the AI picked each and why not — shown during topic review
  const picked = new Map(); stories.forEach((s, i) => { for (const it of s.items) picked.set(it, i + 1); });
  const why = new Map((res.skippedHot || []).map(x => [x.key, x.why]));
  const board = [...rankOf].slice(0, 20).map(([key, r]) => {
    const c = candidates.find(x => x.key === key), at = c.items.map(it => picked.get(it)).find(Boolean);
    const title = c.items.map(i => isBareTweet(i) ? `${i.sourceName}（只有图片/视频）` : i.title).slice(0, 2).join(' ‖ ').slice(0, 120);
    return `| ${r} | ${c.heat.score} | ${title.replace(/\|/g, '/')} | ${heatText(c.heat)} | ${at ? `✅ 第 ${at} 条` : '—'} | ${at ? '' : (why.get(key) || '（没写理由）').replace(/\|/g, '/')} |`;
  });
  if (workDir) await fs.promises.writeFile(path.join(workDir, '..', '选题热度榜.md'), `# 选题热度榜（${date}）\n\n${res.notes || ''}\n\n| 热度排名 | 热度分 | 新闻 | 热度从哪来 | AI 选了吗 | 没选的理由 |\n|---|---|---|---|---|---|\n${board.join('\n')}\n`);
  const missed = [...rankOf].slice(0, 10).filter(([key]) => !candidates.find(x => x.key === key).items.some(it => picked.has(it)));
  if (missed.length) log(`热度前 10 没选的：${missed.map(([key, r]) => `第${r}名（${why.get(key) || '没写理由'}）`).join('；')}`);
  return {stories, notes: res.notes};
}
