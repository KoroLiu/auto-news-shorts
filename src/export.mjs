// Final step of the pipeline: copy everything a person needs to upload by hand into <run>/package/.
// This project ships no upload code; see docs/publishing-guide.md.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// Title length limits of common platforms (characters). noSign: drop the 【sign】 prefix.
export const PLATFORM_TITLES = {
  bilibili: {max: 80},
  douyin: {max: 30},
  kuaishou: {max: 30},
  xiaohongshu: {max: 20, noSign: true},
  wechatChannels: {max: 30},
};

/** Full title if it fits; otherwise 【sign】+short hook, then without the sign, then the first headline cut at punctuation. */
export function shortTitle(info, max, {noSign = false} = {}) {
  const all = String(info.title || '').trim(), sign = (all.match(/^【[^】]+】/) || [''])[0], bare = all.slice(sign.length);
  const list = noSign ? [bare, info.shortHook] : [all, info.shortHook && sign + info.shortHook, bare, info.shortHook];
  const fits = list.filter(Boolean).find(t => t.length <= max);
  if (fits) return fits;
  const head = (noSign ? '' : sign) + String((info.toc?.[0] || bare).replace(/^\d+:\d+\s+/, '')).trim();
  if (head.length <= max) return head;
  const cut = head.slice(0, max), at = Math.max(...['，', '；', '：', '！', ',', ' '].map(c => cut.lastIndexOf(c)));
  return at >= 8 ? cut.slice(0, at) : cut;
}

const mmss = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export const isExported = runDir => fs.existsSync(path.join(runDir, 'exported.json'));

/** Writes <runDir>/package/{video.mp4, cover-landscape.jpg, cover-portrait.jpg, metadata.json, metadata.txt} and <runDir>/exported.json. */
export async function exportPackage({runDir, info, video, coverLandscape, coverPortrait}) {
  const dir = path.join(runDir, 'package');
  await fsp.mkdir(dir, {recursive: true});
  await fsp.copyFile(video, path.join(dir, 'video.mp4'));
  if (fs.existsSync(coverLandscape)) await fsp.copyFile(coverLandscape, path.join(dir, 'cover-landscape.jpg'));
  if (coverPortrait && fs.existsSync(coverPortrait)) await fsp.copyFile(coverPortrait, path.join(dir, 'cover-portrait.jpg'));
  const meta = {
    title: info.title,
    description: info.desc,
    tags: info.tags || [],
    chapters: (info.chapters || []).map(c => ({time: mmss(c.from), title: c.content})),
    platformTitles: Object.fromEntries(Object.entries(PLATFORM_TITLES).map(([p, o]) => [p, shortTitle(info, o.max, o)])),
    exportedAt: new Date().toISOString(),
  };
  await fsp.writeFile(path.join(dir, 'metadata.json'), JSON.stringify(meta, null, 2));
  const txt = [
    `标题：${meta.title}`, '',
    '各平台标题：', ...Object.entries(meta.platformTitles).map(([p, t]) => `  ${p}: ${t}`), '',
    `标签：${meta.tags.join(' ')}`, '',
    '分段章节：', ...meta.chapters.map(c => `${c.time}  ${c.title}`), '',
    '简介：', meta.description || '',
  ].join('\n');
  await fsp.writeFile(path.join(dir, 'metadata.txt'), txt);
  await fsp.writeFile(path.join(runDir, 'exported.json'), JSON.stringify({at: meta.exportedAt}));
  return dir;
}
