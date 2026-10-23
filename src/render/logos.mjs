// 封面上的公司 logo：按新闻标题认出是哪家公司，从 tools/lobe-icons（开源 AI 品牌图标库 @lobehub/icons-static-svg，MIT）取图标。
// 只认下面这张表里的名字（图标库里有很多 pi、make、spark 这种常见词，不能直接拿文件名去匹配标题）。
import fs from 'node:fs';
import path from 'node:path';
import {ROOT, exists, fetchBuffer} from '../util.mjs';
import {fmtStars} from '../github.mjs';
import {HOST} from './portrait.mjs';

const DIR = path.join(ROOT, 'tools', 'lobe-icons', 'icons');

// 图标名: [标题里出现这些词就算]（英文按整词、不分大小写；中文按包含）
const BRANDS = {
  openai: ['OpenAI', 'ChatGPT', 'GPT-?\\d', 'Sora', 'Codex', '奥特曼', 'Altman'],
  claude: ['Anthropic', 'Claude'],
  gemini: ['Gemini'],
  google: ['Google', '谷歌'],
  deepmind: ['DeepMind'],
  meta: ['Meta', 'Llama', '扎克伯格', 'Zuckerberg'],
  microsoft: ['Microsoft', '微软'],
  githubcopilot: ['Copilot'],
  apple: ['Apple', '苹果', 'iPhone', 'Siri'],
  nvidia: ['NVIDIA', 'Nvidia', '英伟达', '黄仁勋'],
  xai: ['xAI'],
  grok: ['Grok'],
  mistral: ['Mistral'],
  deepseek: ['DeepSeek', '深度求索'],
  qwen: ['Qwen', '通义', '千问'],
  alibaba: ['阿里', 'Alibaba'],
  doubao: ['豆包', 'Doubao', 'Seedance', 'Seedream'],
  bytedance: ['字节', 'ByteDance', 'TikTok'],
  hunyuan: ['混元', 'Hunyuan'],
  tencent: ['腾讯', 'Tencent'],
  wenxin: ['文心', 'ERNIE'],
  baidu: ['百度', 'Baidu'],
  kimi: ['Kimi', '月之暗面', 'Moonshot'],
  zhipu: ['智谱', 'GLM', 'Zhipu', 'Z\\.ai'],
  minimax: ['MiniMax', '海螺'],
  stepfun: ['阶跃', 'StepFun'],
  xiaomimimo: ['小米', 'Xiaomi', 'MiMo'],
  huawei: ['华为', 'Huawei', '昇腾'],
  kling: ['可灵', 'Kling'],
  huggingface: ['Hugging ?Face', 'HF'],
  perplexity: ['Perplexity'],
  cursor: ['Cursor'],
  windsurf: ['Windsurf'],
  github: ['GitHub'],
  midjourney: ['Midjourney'],
  runway: ['Runway'],
  stability: ['Stability', 'Stable Diffusion'],
  elevenlabs: ['ElevenLabs'],
  cohere: ['Cohere'],
  ollama: ['Ollama'],
  aws: ['AWS', '亚马逊', 'Amazon'],
  ibm: ['IBM'],
  samsung: ['三星', 'Samsung'],
  manus: ['Manus'],
  suno: ['Suno'],
  lovable: ['Lovable'],
  vercel: ['Vercel'],
  cloudflare: ['Cloudflare'],
  notion: ['Notion'],
  figma: ['Figma'],
  n8n: ['n8n'],
  langchain: ['LangChain'],
  bilibili: ['B站', 'bilibili'],
};

const isAscii = s => /^[\x00-\x7f]+$/.test(s);
const RULES = Object.entries(BRANDS).map(([id, words]) => [id, words.map(w => isAscii(w)
  ? new RegExp(`(^|[^A-Za-z0-9])${w}($|[^A-Za-z0-9])`, 'i') : new RegExp(w))]);

const cache = new Map();
/** 图标转成 data URI（彩色版优先）；图标库里没有就返回 null。 */
export function logoData(id) {
  if (cache.has(id)) return cache.get(id);
  let uri = null;
  for (const f of [`${id}-color.svg`, `${id}.svg`]) {
    const p = path.join(DIR, f);
    if (!exists(p)) continue;
    let svg = fs.readFileSync(p, 'utf8').replace(/ (width|height)="1em"/g, '').replace(/style="[^"]*"/, '');
    // 有白色部分的彩色图标是给深色底用的（Kimi 的 K 是白的，10-23 封面上只剩一个蓝点），白底卡片上改用单色版
    if (f.includes('-color') && /fill="(#fff|#ffffff|white)"/i.test(svg)) continue;
    svg = svg.replace(/currentColor/g, '#122039');
    if (!svg.includes(' fill=') && !f.includes('-color')) svg = svg.replace('<svg ', '<svg fill="#122039" ');
    uri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    break;
  }
  cache.set(id, uri);
  return uri;
}

/** 一段文字里提到了哪些公司（按出现位置排序），返回图标名列表。 */
export function brandsIn(text) {
  const hits = [];
  for (const [id, res] of RULES) {
    let at = Infinity;
    for (const re of res) { const m = re.exec(text || ''); if (m) at = Math.min(at, m.index); }
    if (at < Infinity && logoData(id)) hits.push([at, id]);
  }
  return hits.sort((a, b) => a[0] - b[0]).map(h => h[1]);
}


/** GitHub 板块：认不出公司、但作者是组织（公司/团队）的项目，用组织头像（下载到 media/avatar-组织.png）；个人开发者不放照片，用首字母圆标。 */
async function ownerAvatar(owner, runDir) {
  const file = path.join(runDir, 'media', `avatar-${owner}.png`);
  if (!exists(file)) {
    try {
      const {buf} = await fetchBuffer(`https://avatars.githubusercontent.com/${encodeURIComponent(owner)}?s=256`, {timeoutMs: 15000});
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, buf);
    } catch { return null; }
  }
  return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
}

/** 竖版封面（cover-portrait.html）要的数据。 */
export async function portraitCoverData({stories, col, dp, runDir, variant = 'A'}) {
  const github = col?.mode === 'github';
  const items = [];
  for (const s of stories) {
    const brand = brandsIn(`${s.coverTitle || ''} ${s.title || ''}`).find(id => !github || id !== 'github');
    let logo = brand ? {id: brand, src: logoData(brand)} : null;
    if (!logo && s.repo && s.repoInfo?.ownerType === 'Organization') {
      const owner = s.repo.split('/')[0];
      const src = await ownerAvatar(owner, runDir);
      if (src) logo = {id: 'gh:' + owner, src, kind: 'photo'};
    }
    // 清单里用短标题；GitHub 项目用仓库名
    const title = github && s.repo ? s.repo.split('/')[1] : (s.coverTitle || s.short || s.title);
    const sub = github && s.repoInfo?.stars ? `★ ${fmtStars(s.repoInfo.stars)}` : '';
    items.push({title, mono: github ? title : (s.short || title), logo, sub});
  }
  return {
    variant, column: col?.name || '每日AI要闻', dateISO: dp.iso, dateShort: `${dp.m}.${String(dp.d).padStart(2, '0')}`, year: dp.iso.slice(0, 4),
    weekday: `星期${dp.weekday}`, headline: stories[0]?.coverTitle || stories[0]?.title || '', items, count: stories.length,
    unit: github ? '个项目' : '条', moreWord: github ? '' : '要闻',
  };
}

// ===== Hook cover (cover-hook.html; defaults: portrait P2, landscape L1) =====

const hostData = pose => { const p = path.join(HOST.dir, `cover-${pose}.png`); return exists(p) ? 'data:image/png;base64,' + fs.readFileSync(p).toString('base64') : null; };
// 头条是好消息（开源、发布、融资、登顶……）主持人比赞，其余指着标题
const HAPPY = /开源|发布|上线|推出|突破|新高|融资|免费|登顶|夺冠|第[一1]|开放|大涨|狂揽|涨\S*Star|Star|翻倍|首次|首个|升级/i;
const shortUrl = u => String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '');

/** 一条新闻在卡片上的「产品名 + 公司 + logo」。公司 = 能认出品牌的那个标签（都能认出就取短的）。 */
async function storyCard(s, {github, runDir}) {
  const brand = brandsIn(`${(s.tags || []).join(' ')} ${s.coverTitle || ''} ${s.title || ''}`).find(id => !github || id !== 'github');
  let logo = brand ? logoData(brand) : null, logoKind = '';
  if (!logo && s.repo && s.repoInfo?.ownerType === 'Organization') { logo = await ownerAvatar(s.repo.split('/')[0], runDir); logoKind = 'photo'; }
  if (github && s.repo) {
    const repoName = s.repo.split('/')[1];
    const name = (s.tags || []).find(t => t.toLowerCase() === repoName.toLowerCase()) || repoName; // 仓库名常是小写，标签里有正常大小写
    return {name, company: s.repoInfo?.stars ? `★ ${fmtStars(s.repoInfo.stars)}` : s.repo.split('/')[0], logo, logoKind, mono: name, who: name};
  }
  const [a, b] = s.tags || [];
  let name = b || s.short || a || s.title, company = a || '';
  if (name === company) company = '';
  if (a && b) {
    const ba = brandsIn(a).length > 0, bb = brandsIn(b).length > 0;
    if ((bb && !ba) || (ba && bb && b.length < a.length)) { name = a; company = b; }
  }
  return {name, company, logo, logoKind, mono: company || name, who: company || name};
}

/** 标题拆成三行：钩子（「！」前）/ 主角词（放色块）/ 其余。没有数字式标题时用新闻标题。 */
function titleLines(lead, cardWho) {
  const src = String(lead.hookTitle || lead.coverTitle || lead.title || '').trim();
  const m = src.match(/^(.{2,14}?[！!])\s*(.+)$/);
  const hook = m ? m[1].replace(/!$/, '！') : '', rest = m ? m[2] : src;
  const cands = [...(lead.tags || []), lead.repo?.split('/')[1], cardWho].filter(w => w && w.length <= 16);
  let best = null;
  for (const w of cands) {
    const i = rest.toLowerCase().indexOf(w.toLowerCase());
    if (i >= 0 && (!best || i < best.i || (i === best.i && w.length > best.w.length))) best = {i, w: rest.slice(i, i + w.length)};
  }
  const lines = hook ? [{t: hook}] : [];
  if (best) {
    const pre = rest.slice(0, best.i), post = rest.slice(best.i + best.w.length).replace(/^[，,：:\s]+/, '');
    if (pre.length > 3) lines.push({t: pre});
    const p = pre.length <= 3 ? pre : '';
    if (post.length <= 2) lines.push({pre: p, pill: best.w, t: post});
    else { lines.push({pre: p, pill: best.w}); lines.push({t: post}); }
  } else if (cardWho && cardWho.length <= 16 && rest.length <= 12) {
    // 标题里没出现公司名（如「5%股权投入公益」）：公司名单独放色块一行
    lines.push({pill: cardWho}, {t: rest});
  } else if (rest.length > 9) {
    // 没认出主角词：从中间附近的标点或空格断成两行
    const mid = Math.round(rest.length / 2);
    let cut = -1;
    for (let d = 0; d <= 4 && cut < 0; d++) for (const k of [mid + d, mid - d]) if (/[，,、：:\s]/.test(rest[k] || '')) { cut = k; break; }
    if (cut < 0) cut = mid;
    lines.push({t: rest.slice(0, cut).trim()}, {t: rest.slice(cut).replace(/^[，,、：:\s]+/, '')});
  } else lines.push({t: rest});
  return lines;
}

/** 新封面要的数据。landscape=true 出 B 站横版（L1），否则竖版（P2；头条没有截图或图片就退回 P1 卡片）。 */
export async function hookCoverData({stories, col, dp, runDir, landscape = false, variant, channel}) {
  const github = col?.mode === 'github';
  const cards = [];
  for (const s of stories) cards.push(await storyCard(s, {github, runDir}));
  const lead = stories[0] || {}, leadCard = cards[0] || {};
  // 窗口里的网页截图：头条的原文页面截图优先，其次头条的第一张配图。
  // AI 看图说合格、但视频里放不下的截图在 mediaRejected 里（ai.keep=true），也能用；AI 判不合格的（库存图等）不用。
  const media = [...(lead.media || []), ...(lead.mediaExtra || []), ...(lead.mediaRejected || []).filter(m => m.ai?.keep)]
    .filter(m => m?.file && exists(m.file) && !/\.gif$/i.test(m.file) && m.ai?.keep !== false);
  const pick = media.find(m => m.kind === 'screenshot') || media.find(m => m.kind === 'image');
  const shot = pick ? path.relative(path.join(runDir, '_page'), pick.file).split(path.sep).join('/') : '';
  const url = shortUrl((pick?.kind === 'screenshot' && pick.url) || lead.url || lead.primary?.url || (github && lead.repo ? `github.com/${lead.repo}` : ''));
  // 看点：另外几条的公司名 / 仓库名
  const unit = github ? '个项目' : '条要闻';
  const same = new Set([leadCard.who, ...(lead.tags || [])].filter(Boolean).map(w => w.toLowerCase()));
  const others = [...new Set(cards.slice(1).map(c => c.who).filter(w => w && !same.has(w.toLowerCase())))].slice(0, 3);
  const more = stories.length - 1;
  const sub = more > 0 && others.length ? `还有 ${others.join(' · ')}${more > others.length ? ` 等 ${more} ${unit}` : ''}` : '';
  const v = variant || (landscape ? 'L1' : 'P2');
  const pose = HAPPY.test(`${lead.hookTitle || ''} ${lead.title || ''} ${lead.portrait?.stamp || ''}`) ? 'thumb' : 'point';
  return {
    variant: !landscape && /^P2$/.test(v) && !shot ? 'P1' : v, landscape,
    column: col?.name || '每日AI要闻', date: `${dp.m}月${dp.d}日 周${dp.weekday}`, channel: channel || 'My AI News',
    count: stories.length, unit: github ? '个项目' : '条',
    lines: titleLines(lead, leadCard.who), sub, url, shot, shotKind: pick?.kind || '', pose,
    cards, list: stories.map((s, i) => ({...cards[i], name: github ? cards[i].name : (s.coverTitle || s.short || s.title)})),
    hosts: Object.fromEntries([...new Set([pose, 'point', ...(v === 'P3' ? ['open'] : [])])].map(p => [p, hostData(p)]).filter(([, u]) => u)), // 只带用得上的姿势，图大
  };
}
