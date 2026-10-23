// B 站「分段章节」：播放器进度条分段、显示「章节 · 标题」，点一下就跳过去。
// 规则（2026-10 从创作中心章节编辑器读出，并用 /x/web/viewpoint/rule 实测）：2–10 段；第一段从 00:00 开始；
// 每段至少 5 秒；标题最多 16 字（汉字算 1 字、英文数字算半个字），不能有 emoji。

export const CHAPTER_RULES = {min: 2, max: 10, minSeconds: 5, maxTitle: 16};

/** 按 B 站的算法数字数：汉字等算 1，英文数字算 0.5，最后向上取整。 */
export function chapterTitleLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) n += s.charCodeAt(i) > 255 ? 2 : 1;
  return Math.ceil(n / 2);
}

/** 去掉 emoji 等特殊字符，超过 16 字就截短。 */
export function chapterTitle(s, max = CHAPTER_RULES.maxTitle) {
  let t = String(s || '').replace(/[\uD800-\uDFFF]/g, '').replace(/\s+/g, ' ').trim();
  if (chapterTitleLength(t) <= max) return t;
  while (t && chapterTitleLength(t + '…') > max) t = t.slice(0, -1);
  return t.trim() + '…';
}

/**
 * 把每条新闻变成章节：开场一段（从 00:00 起）+ 每条新闻一段，结尾并进最后一段。
 * 新闻太多放不下时，前面的条目各占一段，剩下的合成「更多快讯（N条）」。
 * items: [{start, title}]，按时间排好；duration: 视频总秒数。返回 [{from, to, content}]（整秒）。
 */
export function buildChapters(items, duration, {max = CHAPTER_RULES.max} = {}) {
  const list = items.filter(s => s.title && Number.isFinite(s.start)).map(s => ({from: Math.round(s.start), content: chapterTitle(s.title)}));
  if (!list.length || !(duration > 0)) return [];
  let chapters = list[0].from > 0 ? [{from: 0, content: '开场：今日速览'}, ...list] : list;
  if (chapters.length > max) {
    const keep = chapters.slice(0, max - 1), rest = chapters.length - keep.length;
    chapters = [...keep, {from: chapters[max - 1].from, content: `更多快讯（${rest}条）`}];
  }
  chapters[0].from = 0;
  // 太短（<5 秒）的段并进前一段
  const end = Math.floor(duration);
  const out = [];
  for (const c of chapters) {
    const prev = out[out.length - 1];
    if (prev && c.from - prev.from < CHAPTER_RULES.minSeconds) continue;
    out.push({...c});
  }
  while (out.length > 1 && end - out[out.length - 1].from < CHAPTER_RULES.minSeconds) out.pop();
  out.forEach((c, i) => { c.to = i + 1 < out.length ? out[i + 1].from : end; });
  return out.length >= CHAPTER_RULES.min ? out.map(({from, to, content}) => ({from, to, content})) : [];
}

/** 旧的期数没存章节时，从时间轴目录（"00:18  标题"）补算。 */
export function chaptersFromToc(toc, duration, opts) {
  const items = (toc || []).map(l => String(l).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(.+)$/)).filter(Boolean)
    .map(m => ({start: m[3] ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) : (+m[1] * 60 + +m[2]), title: m[4].trim()}));
  return buildChapters(items, duration, opts);
}

/** 给人看的一行行「00:18 标题」。 */
export const chapterLines = chapters => chapters.map(c => `${String(Math.floor(c.from / 60)).padStart(2, '0')}:${String(c.from % 60).padStart(2, '0')}  ${c.content}`);
