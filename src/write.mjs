// Script writer: turns each selected story + its original-source facts into on-screen cards and spoken narration.
import path from 'node:path';
import {askJson, pool} from './llm.mjs';
import {writeJson, log, dateParts} from './util.mjs';
import {fmtStars} from './github.mjs';
import {portraitSchema, portraitRules, normalizePortrait} from './write-portrait.mjs';

export const ICON_NAMES = ['rocket', 'cpu', 'brain', 'sparkles', 'zap', 'shield', 'shield-check', 'lock', 'scale', 'gavel', 'landmark', 'globe', 'users', 'user', 'briefcase', 'dollar-sign', 'coins', 'credit-card', 'trending-up', 'trending-down', 'chart-column', 'chart-line', 'code', 'terminal', 'git-branch', 'package', 'box', 'layers', 'database', 'server', 'cloud', 'smartphone', 'monitor', 'laptop', 'image', 'video', 'mic', 'message-square', 'messages-square', 'book-open', 'file-text', 'newspaper', 'search', 'eye', 'clock', 'calendar', 'timer', 'triangle-alert', 'circle-check', 'gift', 'star', 'award', 'trophy', 'target', 'flag', 'link', 'download', 'settings', 'wrench', 'puzzle', 'bot', 'workflow', 'network', 'gauge', 'flask-conical', 'microscope', 'graduation-cap', 'handshake', 'megaphone', 'bell', 'ban', 'refresh-cw', 'arrow-up-right', 'map', 'car', 'store', 'tag', 'percent', 'hard-drive', 'app-window', 'languages', 'pen-tool', 'palette', 'film', 'headphones', 'gamepad-2', 'heart-pulse', 'factory', 'plug', 'battery-charging', 'lightbulb', 'list-checks', 'mail', 'scan-eye', 'key', 'user-plus', 'hand-coins', 'receipt', 'circle-dollar-sign', 'memory-stick'];

const storySchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'skip', 'title', 'short', 'sourceLine', 'coverTitle', 'hookTitle', 'hookShort', 'tweetZh', 'tags', 'cards', 'narration', 'portrait'],
  properties: {
    id: {type: 'string'}, skip: {type: 'boolean'},
    title: {type: 'string'}, short: {type: 'string'}, sourceLine: {type: 'string'}, coverTitle: {type: 'string'}, hookTitle: {type: 'string'}, hookShort: {type: 'string'}, tweetZh: {type: 'string'},
    tags: {type: 'array', items: {type: 'string'}},
    cards: {type: 'array', items: {type: 'object', additionalProperties: false, required: ['icon', 'heading', 'body'], properties: {icon: {type: 'string', enum: ICON_NAMES}, heading: {type: 'string'}, body: {type: 'string'}}}},
    narration: {type: 'array', items: {type: 'object', additionalProperties: false, required: ['text', 'card'], properties: {text: {type: 'string'}, card: {type: 'integer'}}}},
    portrait: portraitSchema,
  },
};
const batchSchema = {type: 'object', additionalProperties: false, required: ['stories'], properties: {stories: {type: 'array', items: storySchema}}};

// single=板块只有一个栏目（如每日AI要闻）：每条都标「要闻」，按重要性决定长短，免得条条写成长稿
function lengthGuide(s, single = false, col = null) {
  if (col?.lengthGuide) return col.lengthGuide; // 板块统一的长短（如 GitHub 项目每个都差不多长）
  if ((s.chapter === '要闻' && !single) || s.importance >= 8) return '重点条目：口播 160–260 字（5–8 句），卡片 4–6 张';
  if (s.importance >= 5) return '普通条目：口播 80–140 字（3–5 句），卡片 3–4 张';
  return '简讯：口播 45–80 字（2–3 句），卡片 2–3 张';
}

const RULES = `【写作要求】
你在给一档 B 站 AI 日报视频写稿。主播是一位声音温柔、专业的女主播，观众是关注 AI 的普通用户和开发者。
1. 只根据给出的原文材料写，不得添加材料里没有的事实、数字、日期、评价；材料不足以说清楚这条新闻时，把 skip 设为 true。
2. 口播（narration）：口语化、简洁、信息密度高。每条标注的口播字数范围是硬性上限，宁短勿长，超出会让视频过长；只挑最关键的信息，不要把材料里的细节都讲一遍。每句 10–32 个字，像真人播报；narration 的每个元素只放一句话。第一句直接说清楚“谁做了什么”；中间讲 1–3 个最关键的细节（数字、能力、价格、范围）；最后可以说上线时间、适用范围或影响。
   - 不要说“官方资料显示”“据悉”之类套话，不要每条都重复“近日”；需要归因时简短地说“官方称”“据 某某 报道”。传闻必须说明是传闻。
   - 不要 markdown、emoji、括号注释、网址、特殊符号（≥ ≤ → ~ × / 等）；用“超过”“约”“到”等中文表达。英文产品名、型号保持原样（如 GPT-5、Claude Code）。数字用阿拉伯数字。
   - 每句标注它主要在讲哪张卡片：card 填卡片序号（从 0 开始），泛泛的句子填 -1。
3. 卡片（cards）：屏幕上的要点卡，和口播互相对应。heading 不超过 9 个字（如“价格下调”“上下文 100 万”），body 不超过 46 个字（超出会被截断）、写具体事实；icon 从给定列表选最贴切的。
4. title：新闻标题式，不超过 24 个字，主语明确（例：“OpenAI 上线 ChatGPT Slides”“DeepSeek 新增搜索与抓取 API”）。short：进度条上的超短标签，不超过 6 个字（例：“Slides”“出口管制”）。coverTitle：不超过 12 个字的封面标语。
5. sourceLine：屏幕上的来源说明，格式“来源 · 机构或媒体名 · 10月16日”（日期不确定就省略日期）。**优先写官方**：有官方推文写“来源 · MiniMax 官方推特”，有官网/官方博客写“来源 · Mistral 官方博客”；没有官方来源时写一手报道的权威媒体（如华尔街日报、路透社、The Verge）；不要写 36氪、IT之家、量子位、Techmeme、Hacker News、Reddit 这类转载、聚合或社区网站，除非它是唯一来源。
6. tags：1–2 个适合做 B 站标签的关键词（公司或产品名）。
7. tweetZh：材料里如果有【官方推文】，把这条推文忠实、通顺地翻译成中文（不超过 140 字，去掉链接和话题标签），会以“推文卡片”的形式显示在画面上；没有推文就留空字符串。
8. hookTitle：这条当本期头条时用的视频标题（「数字式」）。先用这条新闻里最抓眼球的 1–2 个硬数字开头当钩子（4–12 字，以“！”结尾），再用一句话点出主角，可以留一点悬念，整个不超过 36 字，末尾不加标点。
   - 钩子要是一句通顺的人话，“变化/动作 + 数字”，只讲一件事，例如“提速3倍、便宜七成！”“一周涨22.9万Star！”“拿出5%股权做公益！”“投69份简历拿到20个面试！”“100万块GPU！”；不要把数字和词硬拼，像“22.9万星周涨！”“周涨4138星、压缩98%！”“将达约1M个GPU！”就不行。
   - 钩子里只放 1 个最惊人的数字（同一件事的两个数可以并列，如“提速3倍、便宜七成”）；用中文常用单位（100万、15亿美元，不写 1M、1.5B），Star 就写 Star；“约”“将达”这类词放到后半句或不写。
   - 后半句例：“匿名霸榜的神秘模型终于露面”“这个开源项目让 AI 逆向分析任何软件”。整句例：“提速3倍、便宜七成！匿名霸榜的神秘模型 Space Bunny 终于露面”。
   - 数字必须原样来自材料，不许估算、换算出材料里没有的数，也不许编造；材料里没有像样的数字，就用最具体的事实开头（如“首次开源！”）。
   - 语气克制：不用“核弹”“炸裂”“大地震”“杀疯了”“颤栗”“震惊”这类夸张词。没坐实的消息要带“据报”“拟”“或将”。
   - 不写【】署名、日期、栏目名（程序会加）。
   hookShort：同一个意思压到 18 字以内（给小红书、视频号用），同样以那个数字或具体事实开头，必须保留主角名字（公司、产品或仓库名），例：“全面开源！DeepSeek公开推理框架”“一周涨22.9万Star！REA”。
9. 用简体中文。${portraitRules}`;

export async function writeStories(stories, {cfg, date, workDir}) {
  const batches = [];
  const size = cfg.llm?.batchSize || 5;
  for (let i = 0; i < stories.length; i += size) batches.push(stories.slice(i, i + size));
  const results = await pool(batches, cfg.llm?.concurrency || 3, async (batch, bi) => {
    // nonAI：每期最多一条的非 AI 科技大事，写法见 config.json 的 columns.news.nonAI.writeRule
    const body = batch.map(s => `==== 条目 ${s.id}｜栏目：${s.chapter}｜${lengthGuide(s, cfg.column?.chapters?.length === 1, cfg.column)}\n主编给的工作标题：${s.workingTitle}\n入选理由：${s.reason}\n${s.nonAI && cfg.column?.nonAI?.writeRule ? `${cfg.column.nonAI.writeRule}\n和 AI 的关系：${s.aiAngle || '（没有，不提 AI）'}\n` : ''}${s.facts}`).join('\n\n');
    const prompt = `今天是 ${date}。请为下面 ${batch.length} 条新闻分别写视频稿，按输入顺序输出，id 原样返回。\n\n${RULES}\n\n${cfg.column?.writeRules ? cfg.column.writeRules + '\n\n' : ''}可选图标：${ICON_NAMES.join(', ')}\n\n${body}`;
    try {
      const res = await askJson(prompt, batchSchema, {cfg, workDir, label: `写稿 ${bi + 1}/${batches.length}`});
      return res.stories || [];
    } catch (e) { log(`写稿批次 ${bi + 1} 失败，跳过这些条目：${e.message.slice(0, 200)}`); return []; }
  });
  const byId = new Map(results.flat().map(s => [s.id, s]));
  const out = [];
  for (const s of stories) {
    const w = byId.get(s.id);
    if (!w || w.skip || !w.narration?.length || !w.cards?.length) { log(`跳过 ${s.id} ${s.workingTitle}（材料不足或生成失败）`); continue; }
    const cards = w.cards.slice(0, 6).map(c => ({icon: ICON_NAMES.includes(c.icon) ? c.icon : 'sparkles', heading: clean(c.heading).slice(0, 12), body: clean(c.body).slice(0, 60)}));
    const narration = w.narration.map(n => ({text: cleanSpeech(n.text), card: Number.isInteger(n.card) && n.card >= 0 && n.card < cards.length ? n.card : -1})).filter(n => n.text);
    let sourceLine = s.repoInfo ? repoLine(s) : clean(w.sourceLine);
    // 保险：有官方推文，AI 却写成了转载/聚合网站，就改回官方推特（来源以官方为主）
    if (!s.repoInfo && s.tweet && (/36氪|IT之家|量子位|Techmeme|Hacker News|Reddit/i.test(sourceLine) || !sourceLine)) {
      const d = s.tweet.date ? new Date(s.tweet.date) : null;
      sourceLine = `来源 · ${s.tweet.name || '@' + s.tweet.handle} 官方推特${d && !isNaN(d) ? ` · ${dateParts(d).m}月${dateParts(d).d}日` : ''}`;
    }
    const portrait = normalizePortrait(w.portrait, s.facts || '', message => log(`⚠️ ${s.id} ${message}`));
    out.push({...s, tweetZh: clean(w.tweetZh).slice(0, 180), title: clean(w.title).slice(0, 34), short: clean(w.short).slice(0, 8), sourceLine, coverTitle: clean(w.coverTitle).slice(0, 16), ...hookOf(w, s), tags: (w.tags || []).map(clean).filter(Boolean).slice(0, 2), cards, narration, portrait});
  }
  await writeJson(path.join(workDir, '..', 'script.json'), out.map(s => ({id: s.id, chapter: s.chapter, title: s.title, short: s.short, sourceLine: s.sourceLine, coverTitle: s.coverTitle, hookTitle: s.hookTitle, hookShort: s.hookShort, tags: s.tags, cards: s.cards, narration: s.narration, portrait: s.portrait, url: s.primary?.url, media: s.media})));
  log(`写稿完成：${out.length} 条`);
  return out;
}

// GitHub 项目：画面标题下面那行固定显示「仓库名 + Star 数」（程序填，不让 AI 写，免得数字写错）
export function repoLine(s) {
  const r = s.repoInfo || {};
  const stars = r.stars || s.heat?.ghStars || 0, week = r.starsWeek || s.heat?.ghStarsWeek || 0;
  return ['来源 · GitHub', r.fullName || s.repo, stars ? `${fmtStars(stars)} Star` + (week ? `（本周 +${fmtStars(week)}）` : '') : ''].filter(Boolean).join(' · ');
}

// 视频标题（数字式）：标题里的每个数字都要能在原文材料里找到（允许 22.9万 ↔ 229123 这种换算、3% 以内误差），
// 对不上就不用，回退成普通新闻标题——宁可平淡，不能写错数字。
function hookOf(w, s) {
  const hookTitle = tidyHook(w.hookTitle, 40), hookShort = tidyHook(w.hookShort, 18);
  const bad = [...new Set([hookTitle, hookShort].flatMap(x => unbackedNumbers(x, `${s.facts || ''} ${s.workingTitle || ''}`)))];
  if (bad.length) { log(`⚠️ ${s.id} 标题里的数字 ${bad.join('、')} 在原文材料里找不到，这条不用数字式标题`); return {hookTitle: '', hookShort: ''}; }
  return {hookTitle, hookShort};
}
function tidyHook(x, max) {
  let s = clean(x).replace(/[【】]/g, '');
  const over = s.length > max;
  if (over) {
    // 截在最后一个空格或标点处，不留下半个英文词；边界刚好在上限后也可用。
    const boundaries = [...s.slice(0, max + 1).matchAll(/[\s\p{P}]/gu)].map(m => m.index);
    s = boundaries.length ? s.slice(0, boundaries.at(-1)) : '';
  }
  s = s.replace(/[\s\p{P}]+$/gu, '');
  return over && s.length < 8 ? '' : s;
}
const UNIT = {'万': 1e4, '亿': 1e8, k: 1e3, K: 1e3, M: 1e6, B: 1e9};
// step：最后一位代表多少（1.6万 → 1000），用来认「16569 写成 1.6万（多）」这种四舍五入或去尾
const numbersIn = text => [...String(text).replace(/(\d),(?=\d{3})/g, '$1').matchAll(/(\d+(?:\.(\d+))?)\s*(万|亿|k|K|M|B)?/g)]
  .map(m => { const u = UNIT[m[3]] || 1; return {raw: m[0].trim(), v: +m[1] * u, n: +m[1], step: u / 10 ** (m[2]?.length || 0)}; });
// 英文材料里写成单词的数（README 里的「Sixty-nine applications」）
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const wordsToDigits = t => String(t).replace(new RegExp(`\\b(?:(${TENS.slice(2).join('|')})(?:[- ](${ONES.slice(1, 10).join('|')}))?|(${ONES.join('|')}))\\b`, 'gi'),
  (_, tens, one, single) => String(single ? ONES.indexOf(single.toLowerCase()) : TENS.indexOf(tens.toLowerCase()) * 10 + (one ? ONES.indexOf(one.toLowerCase()) : 0)));
export function unbackedNumbers(title, facts) {
  const have = numbersIn(wordsToDigits(facts)).flatMap(h => [h.v, h.n]);
  const ok = (x, f) => [[x.v, x.step], [x.n, x.step / (x.v / x.n || 1)]].some(([v, step]) => (f >= v - step / 2 && f < v + step) || (v > 0 && Math.abs(f - v) / v <= 0.03));
  return numbersIn(title).filter(x => !have.some(f => ok(x, f))).map(x => x.raw);
}

const clean = s => String(s ?? '').replace(/[*#`]/g, '').replace(/\s+/g, ' ').trim();
function cleanSpeech(s) {
  return clean(s).replace(/https?:\/\/\S+/g, '').replace(/≥/g, '大于等于').replace(/≤/g, '小于等于').replace(/→/g, '到').replace(/~/g, '到').replace(/×/g, '乘').replace(/[（(][^）)]{0,30}[）)]/g, '').trim();
}
