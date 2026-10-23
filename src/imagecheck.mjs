// AI 看图把关：写完稿后，把每条新闻的候选配图连同标题、口播稿一起交给 Codex 看，
// 只留下观众看了能获得信息的图（图表、产品界面、官方发布图、相关网页截图、新闻主角），资料图 / 库存图 / 装饰插画 / 无关的图扔掉。
// 同时让它写图注、指出这张图配口播的第几句（timeline.mjs 按这句弹出）。宁可不放，也不放无关的图。
// 结果：s.media = 用的图（带 caption / sentence / ai），s.mediaRejected = 没用的图（带 ai.reason），工作台里可以加回。
import fs from 'node:fs';
import path from 'node:path';
import {log, run, findFfmpeg} from './util.mjs';
import {askVision, pool, visionAvailable} from './llm.mjs';

export const CATEGORIES = {chart: '图表/数据', product: '产品界面', official: '官方发布图', page: '网页截图', person: '人物', stock: '资料图/库存图', decorative: '装饰插画', unrelated: '无关', other: '其他'};
const PRIORITY = {official: 0, chart: 0, product: 0, person: 1, page: 2, other: 3};
export const maxMediaFor = s => s.repoInfo ? 2 : (s.chapter === '要闻' ? 2 : 1) - (s.tweet ? 1 : 0) + (s.chapter === '要闻' && s.tweet ? 1 : 0);

const SCHEMA = {type: 'object', additionalProperties: false, required: ['images'], properties: {images: {type: 'array', items: {type: 'object', additionalProperties: false,
  required: ['index', 'category', 'keep', 'caption', 'sentence', 'reason'],
  properties: {index: {type: 'integer'}, category: {type: 'string', enum: Object.keys(CATEGORIES)}, keep: {type: 'boolean'}, caption: {type: 'string'}, sentence: {type: 'integer'}, reason: {type: 'string'}}}}}};

function prompt(s, n) {
  return `你是科技资讯视频的图片编辑。下面这条新闻在视频里会弹出配图，附上了 ${n} 张候选图（按附件顺序编号 1 到 ${n}）。请逐张看图判断。

新闻标题：${s.title}
要点：${(s.cards || []).map(c => `${c.heading}：${c.body}`).join('；')}
口播稿（句子编号从 0 开始）：
${(s.narration || []).map((x, i) => `${i}. ${x.text}`).join('\n')}

每张图给出：
- category：chart 图表/数据/跑分；product 产品或软件界面、演示画面；official 专门为这条新闻发布的官方图（含相关文字或产品）；page 网页截图（能看到这条新闻的标题或内容）；person 人物照片；stock 资料图、库存照片、和本条没有具体关系的通用配图（如泛泛的公司 logo 墙、服务器机房、人物活动旧照）；decorative 装饰插画、艺术画、抽象背景；unrelated 和这条新闻无关；other 其他。
- keep：观众看了能获得和这条新闻直接相关的信息，才填 true。stock、decorative、unrelated 一律 false；person 只有新闻主角就是这个人时才 true；page 如果是登录页、cookie 弹窗、空白页、报错页、和本条无关的首页，填 false。拿不准就填 false，宁可不放。
- caption：4 到 14 个字的中文图注，说清图里是什么（例：「DeepSeek V4.1 跑分对比」「Claude Code 插件目录页面」），不要写“图片”“配图”“资料图”。不保留的图也写。
- sentence：这张图最适合在口播第几句时出现（填上面的编号）；没有明显对应就填 -1。
- reason：一句话理由。
index 填图的编号（1 到 ${n}）。
图片已经作为附件直接给你了：直接看附件回答，不要运行任何命令、不要读写文件、不要上网。动图会拼成 2×2 的四格画面给你。`;
}

// Codex 看图只稳定支持 png / jpg：webp 转成 jpg；gif 动图第一帧常是空白，抽 4 帧拼成 2×2 一张图再给它看
async function viewable(file, cfg, tmpDir) {
  if (/\.(png|jpe?g)$/i.test(file)) return file;
  const out = path.join(tmpDir, path.basename(file).replace(/\.\w+$/, '') + '-看图.jpg');
  if (!fs.existsSync(out)) {
    const gif = /\.gif$/i.test(file);
    const vf = gif ? ['-vf', 'select=gte(t\\,1),fps=1/3,scale=640:-2,tile=2x2'] : [];
    let r = await run(findFfmpeg(cfg).ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, ...vf, '-frames:v', '1', out], {timeoutMs: 60000});
    if (r.code !== 0 && gif) r = await run(findFfmpeg(cfg).ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', out], {timeoutMs: 60000});
    if (r.code !== 0) throw new Error('转换图片失败：' + path.basename(file));
  }
  return out;
}

/** 给一条新闻挑图。返回 {media, rejected}；AI 出错时抛异常（调用方保留原来的图）。 */
export async function checkStoryImages(s, {cfg, workDir}) {
  const cands = [...(s.media || []), ...(s.mediaExtra || [])].filter(m => m.file && fs.existsSync(m.file)).slice(0, 6);
  if (!cands.length) return {media: [], rejected: []};
  const tmp = path.join(workDir, 'imagecheck'); fs.mkdirSync(tmp, {recursive: true});
  const files = [];
  for (const m of cands) files.push(await viewable(m.file, cfg, tmp));
  const out = await askVision(prompt(s, cands.length), SCHEMA, files, {cfg, workDir: tmp, label: `看图 ${s.id}`});
  const byIdx = new Map((out.images || []).map(x => [x.index, x]));
  const n = (s.narration || []).length;
  const judged = cands.map((m, i) => {
    const a = byIdx.get(i + 1) || {category: 'other', keep: false, caption: '', sentence: -1, reason: 'AI 没给出判断'};
    const sentence = Number.isInteger(a.sentence) && a.sentence >= 0 && a.sentence < n ? a.sentence : -1;
    const {mediaExtra, ...rest} = m;
    return {...rest, caption: String(a.caption || '').trim().slice(0, 20), sentence, ai: {category: a.category, keep: !!a.keep, reason: String(a.reason || '').slice(0, 120)}};
  });
  const max = Math.max(0, maxMediaFor(s));
  const keep = judged.filter(m => m.ai.keep).sort((a, b) => (PRIORITY[a.ai.category] ?? 3) - (PRIORITY[b.ai.category] ?? 3));
  const media = keep.slice(0, max);
  const rejected = [...keep.slice(max).map(m => ({...m, ai: {...m.ai, reason: `合格，但这条最多放 ${max} 张，留作备选`}})), ...judged.filter(m => !m.ai.keep)];
  return {media, rejected};
}

/** 整期挑图（main.mjs 写稿后调用）。cfg.enrich.imageCheck=false 时跳过。会直接改 stories 里的 media / mediaRejected。 */
export async function checkImages(stories, {cfg, workDir}) {
  if (cfg.enrich?.imageCheck === false) { log('AI 看图把关已关闭（config.json enrich.imageCheck）'); return stories; }
  if (!visionAvailable(cfg)) { log('未配置看图模型（llm.vision），跳过 AI 看图把关，按默认规则挑图'); return stories; }
  let kept = 0, dropped = 0, failed = 0;
  await pool(stories.filter(s => (s.media?.length || s.mediaExtra?.length)), 3, async s => {
    try {
      const {media, rejected} = await checkStoryImages(s, {cfg, workDir});
      s.media = media; s.mediaRejected = rejected; delete s.mediaExtra; s.imageCheck = 'ok';
      kept += media.length; dropped += rejected.filter(m => !m.ai.keep).length;
    } catch (e) {
      // AI 看不了图时不卡住当天的视频：保留原来的图，工作台里标出「没检查」
      s.imageCheck = 'failed'; delete s.mediaExtra; failed++;
      log(`看图 ${s.id} 失败，先用原来的配图：${String(e.message).slice(0, 200)}`);
    }
  });
  log(`AI 看图把关：用 ${kept} 张，扔掉 ${dropped} 张不相关的${failed ? `，${failed} 条没检查成功（用原图）` : ''}`);
  return stories;
}
