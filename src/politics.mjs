// Optional political-content gate (config.select.politicsFilter, default on). Short-video platforms may limit reach of
// political news, so the AI editor flags (never drops) such stories, a keyword list backs it up, and flagged stories stop
// at topic review for a human decision (see main.mjs). Nothing is removed automatically.

// Rule appended to every column's topic-selection prompt
export const POLITICS_RULE = `【政治内容：只标注，不剔除、不减分，由人工决定】
完全按新闻价值和热度挑选，不要因为新闻沾政治就不选或降低 importance——跟政治有关的大新闻照样选进来，交给人工决定留不留。
需要标注的政治内容：地缘政治和国家之间的较量（制裁、禁令、出口管制、关税、实体清单、贸易战、领土和主权争议）、各国政府或官方的立场和表态（外交部回应、反制、谴责、政府政策文件）、国家领导人和政要的言论和行动、选举、战争和军事、抗议和社会冲突、国家安全审查。
每条入选的新闻都要填 politics：明显涉及上面这些填 "yes"；有一点沾边、拿不准的填 "unsure"；完全不沾政治填 "none"。"yes" 和 "unsure" 都要在 politicsWhy 写一句为什么（"none" 时留空）。拿不准时宁可填 "unsure"，程序会停下来让人决定。`;

// Keyword backstop: if the AI misses a flag, these words in the title/reason count as "unsure"
const WORDS = [
  '中方', '美方', '外交部', '国务院', '白宫', '国会', '参议院', '众议院', '议员', '总统', '国家主席', '总理', '首相', '领导人', '政要',
  '反制', '制裁', '禁令', '出口管制', '实体清单', '关税', '贸易战', '地缘', '国家安全', '主权',
  '台湾', '台海', '香港', '新疆', '西藏', '南海', '俄乌', '乌克兰', '以色列', '巴勒斯坦', '加沙', '伊朗', '朝鲜',
  '战争', '军方', '军事', '五角大楼', '大选', '选举', '抗议',
  '习近平', '特朗普', '拜登', '普京', '泽连斯基', '万斯',
];
const EN = /\b(white house|congress|senate|senator|sanctions?|export controls?|entity list|tariffs?|trump|biden|xi jinping|putin|zelensky|vance|beijing|kremlin|taiwan|ukraine|gaza|iran|north korea|pentagon|military|election|national security|chinese government|ccp)\b/i;

/** 一条入选新闻里命中的政治关键词（标题、入选理由、各来源标题） */
export function politicsHits(story) {
  const text = [story.workingTitle, story.reason, ...(story.items || []).map((i) => i.title)].filter(Boolean).join(' \n ');
  const hits = WORDS.filter((w) => text.includes(w));
  const m = text.match(EN);
  if (m) hits.push(m[1]);
  return [...new Set(hits)];
}

/** 给每条新闻定 politics 标记：AI 标了 yes 就是 yes；AI 标了 unsure，或关键词命中，就是 unsure */
export function markPolitics(story, ai = {}) {
  const hits = politicsHits(story);
  const flagged = ai.politics === 'yes' || ai.politics === 'unsure';
  if (!flagged && !hits.length) return null;
  const why = [flagged ? `AI：${ai.politicsWhy || (ai.politics === 'yes' ? '涉及政治' : '拿不准')}` : '', hits.length ? `关键词：${hits.join('、')}` : ''].filter(Boolean).join('；');
  return { flag: ai.politics === 'yes' ? 'yes' : 'unsure', why };
}
