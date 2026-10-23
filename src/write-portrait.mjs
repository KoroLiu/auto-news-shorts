// 写稿附带的竖屏内容。旧稿缺字段时仍能使用；不生成或覆盖 portrait-extra.json。
import {loadConfig} from './util.mjs';

// 「一句话总结」开关（config.json 的 render.portrait.conclusion，默认关）：关着就不让模型写 comment、stamp，省写稿时间和钱
export const CONCLUSION = (() => { try { return loadConfig().render?.portrait?.conclusion === true; } catch { return false; } })();
const text = {type: 'string'};
const metric = (small = false) => ({
  anyOf: [
    {type: 'null'},
    {
      type: 'object', additionalProperties: false,
      required: ['v', 'k', ...(small ? ['small'] : []), 'evidence'],
      properties: {v: text, k: text, ...(small ? {small: text} : {}), evidence: text},
    },
  ],
});
export const portraitSchema = {
  type: 'object', additionalProperties: false,
  required: ['tab', 'ribbon', 'ribbonSub', 'hero', 'chip', ...(CONCLUSION ? ['comment', 'stamp'] : [])],
  properties: {tab: text, ribbon: text, ribbonSub: text, hero: metric(true), chip: metric(), ...(CONCLUSION ? {comment: text, stamp: text} : {})},
};

export const portraitRules = `
10. portrait：同一次写稿附带竖屏画面的文字，不要另写文件。
   - tab：顶部短标签，不超过 8 字；ribbon：画面标题，不超过 24 字；ribbonSub：简短事实副标题，不超过 28 字。
   - hero：最值得突出的一个数字，格式 {v,k,small,evidence}。v 是数字和单位（不超过 12 字），k 是指标名（不超过 10 字），small 补充比较对象或限定范围（不超过 32 字）。
   - chip：第二个重要数字，格式 {v,k,evidence}，长度要求同上。没有合适数字时 hero、chip 必须填 null，不要拿型号或年份凑数。
   - 每个数字的 evidence 必须逐字摘录原文材料中说明该指标的一段话；v 必须原样出现在 evidence 中，保留单位、正负号，不做换算。例如原文是“降低70%”，v 写“70%”，k 写“成本降幅”，不要写“-70%”。
   - hero 的数字也要在本条口播中讲到。数字的含义、比较对象、官方宣称或传闻等限定不能丢。${CONCLUSION ? `
   - comment：讲完后单独配音的一句话总结，10–32 字，只总结已说明的事实，不新增判断、承诺或数字，不重复口播末句；可用逗号断句，不要换行、网址、emoji 或特殊符号。
   - stamp：结论卡上的短印章，2–4 字，如“新发布”“已开源”“待验证”，必须符合原文，不夸张。不适合总结时 comment 和 stamp 都留空。` : ''}`;

const clean = value => typeof value === 'string' ? value.replace(/[*#`]/g, '').replace(/\s+/g, ' ').trim() : '';
const compact = value => clean(value).replace(/\s/g, '');
// 超长文字舍弃，避免截断数字、单位或“据报”等限定词。
const bounded = (value, max) => { const s = clean(value); return s.length <= max ? s : ''; };
const hasValue = (evidence, value) => {
  const escaped = compact(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d.%万亿])`).test(compact(evidence));
};

export function normalizePortrait(value, facts, warn = () => {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalizeMetric = (m, name, small = false) => {
    if (!m) return null;
    const v = bounded(m.v, 12), k = bounded(m.k, 10), evidence = clean(m.evidence);
    const detail = small ? bounded(m.small, 32) : '';
    if (!v || !k || !/\d/.test(v) || !evidence ||
        !compact(facts).includes(compact(evidence)) || !hasValue(evidence, v) ||
        (small && clean(m.small) && !detail)) {
      warn(`${name} 缺少有效原文依据或超过长度限制，已省略`);
      return null;
    }
    return {v, k, ...(small ? {small: detail} : {}), evidence};
  };
  const comment = CONCLUSION ? bounded(value.comment, 32) : '';
  return {
    tab: bounded(value.tab, 8), ribbon: bounded(value.ribbon, 24), ribbonSub: bounded(value.ribbonSub, 28),
    hero: normalizeMetric(value.hero, '大数字', true), chip: normalizeMetric(value.chip, '辅助数字'),
    comment, stamp: comment ? bounded(value.stamp, 4) : '',
  };
}
