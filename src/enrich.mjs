// For each selected story: read the original article (facts for the script) and gather visuals (og:image, article figures, page screenshot).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fetchText, fetchBuffer, log, writeJson} from './util.mjs';
import {stripHtml, decodeEntities} from './collect.mjs';
import {pool} from './llm.mjs';
import {launchBrowser, openPage} from './render/cdp.mjs';
import {maxMediaFor} from './imagecheck.mjs';
import {repoOf, reposIn, repoInfo, readmeImages, readmeText, fmtStars} from './github.mjs';

const SKIP_FETCH = /(^|\.)(x\.com|twitter\.com|weibo\.com|s\.weibo\.com|reddit\.com|redd\.it|news\.ycombinator\.com|youtube\.com|youtu\.be|bilibili\.com|t\.co)$/i;
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

function pickPrimary(items) {
  const score = i => (i.kind === 'official' ? 50 : i.kind === 'media' ? 30 : i.kind === 'release' ? 25 : i.kind === 'trending' ? 15 : 10) - (SKIP_FETCH.test(host(i.url)) ? 40 : 0) + (i.lang === 'zh' ? 2 : 0);
  return items.slice().sort((a, b) => score(b) - score(a));
}

function meta(html, names) {
  for (const n of names) {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, 'i'));
    if (m && m[1]) return decodeEntities(m[1]);
  }
  return '';
}

export function extractArticle(html, baseUrl) {
  const clean = html.replace(/<(script|style|noscript|svg|nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, ' ');
  let body = (clean.match(/<article[\s\S]*?<\/article>/gi) || []).sort((a, b) => b.length - a.length)[0]
    || (clean.match(/<main[\s\S]*?<\/main>/i) || [])[0] || clean;
  const text = stripHtml(body).split('\n').map(s => s.trim()).filter(s => s.length > 1).join('\n');
  const imgs = [];
  for (const m of body.matchAll(/<img[^>]+>/gi)) {
    const tagStr = m[0];
    const src = (tagStr.match(/\s(?:data-src|data-original|src)=["']([^"']+)/i) || [])[1]; if (!src || src.startsWith('data:')) continue;
    const w = parseInt((tagStr.match(/\swidth=["']?(\d+)/i) || [])[1] || '0', 10);
    if (/logo|avatar|icon|emoji|sprite|badge|pixel|1x1/i.test(src) || (w && w < 400)) continue;
    try { imgs.push(new URL(decodeEntities(src), baseUrl).href); } catch {}
    if (imgs.length >= 4) break;
  }
  // 文章里指向官方网站或权威媒体的链接（转载文章常带「原文链接」），用来顺藤摸瓜找官方原文
  const links = [];
  for (const m of body.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(decodeEntities(m[1]), baseUrl);
      const h = u.hostname.replace(/^www\./, '');
      if (!/^https?:$/.test(u.protocol) || h === new URL(baseUrl).hostname.replace(/^www\./, '') || REPOST_SITES.test(h)) continue;
      if ((OFFICIAL_HOSTS.test(h) || TRUSTED_MEDIA.test(h)) && !/\/(tag|tags|category|search|login|signup)\b|twitter\.com|x\.com/i.test(u.href) && !links.includes(u.href)) links.push(u.href);
    } catch {}
    if (links.length >= 6) break;
  }
  return {
    links,
    title: meta(html, ['og:title', 'twitter:title']) || stripHtml((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''),
    description: meta(html, ['og:description', 'description', 'twitter:description']),
    image: (() => { const u = meta(html, ['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']); try { return u ? new URL(u, baseUrl).href : ''; } catch { return ''; } })(),
    published: meta(html, ['article:published_time', 'og:published_time', 'publish_date', 'date', 'pubdate']),
    siteName: meta(html, ['og:site_name', 'application-name']),
    text: text.slice(0, 6000), images: imgs,
  };
}

export function imageSize(buf) {
  try {
    if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return [buf.readUInt32BE(16), buf.readUInt32BE(20), 'png'];
    if (buf.toString('ascii', 0, 3) === 'GIF') return [buf.readUInt16LE(6), buf.readUInt16LE(8), 'gif'];
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const t = buf.toString('ascii', 12, 16);
      if (t === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff, 'webp'];
      if (t === 'VP8L') { const b = buf.readUInt32LE(21); return [(b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1, 'webp']; }
      if (t === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3), 'webp'];
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let o = 2;
      while (o < buf.length) {
        if (buf[o] !== 0xff) { o++; continue; }
        const mk = buf[o + 1]; const len = buf.readUInt16BE(o + 2);
        if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return [buf.readUInt16BE(o + 7), buf.readUInt16BE(o + 5), 'jpg'];
        o += 2 + len;
      }
    }
  } catch {}
  return null;
}

async function saveImage(url, file) {
  const {buf} = await fetchBuffer(url, {timeoutMs: 20000, headers: {referer: new URL(url).origin + '/'}});
  const sz = imageSize(buf); if (!sz) throw new Error('不支持的图片格式');
  const [w, h, ext] = sz;
  if (w < 480 || h < 240 || w / h > 3.4 || w / h < .45) throw new Error(`尺寸不合适 ${w}x${h}`);
  const out = file + '.' + ext; await fsp.writeFile(out, buf);
  return {file: out, w, h};
}

// 在原文网页里运行：找新闻标题（h1，或字号最大的标题），再看标题下面的正文段落，算出「标题 + 开头几段正文」的矩形。
// 横向只取标题和正文段落的范围，所以网站的左边菜单、右边热榜不会进来；纵向从标题上方一点开始，导航栏也不会进来。
// 找不到像样的标题和正文就返回 null，照旧截整屏。
function articleClip() {
  const vis = el => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 120 && r.height > 12 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; };
  const len = el => (el.innerText || '').replace(/\s+/g, '').length;
  const fs = el => parseFloat(getComputedStyle(el).fontSize) || 0;
  const pageTop = el => el.getBoundingClientRect().top + scrollY;
  const heads = [...document.querySelectorAll('h1, h2, [class*="title" i]')].filter(h => vis(h) && len(h) >= 6 && len(h) <= 160 && fs(h) >= 20 && pageTop(h) < 1800);
  if (!heads.length) return null;
  const h1s = heads.filter(h => h.tagName === 'H1');
  const head = (h1s.length ? h1s : heads).sort((a, b) => fs(b) - fs(a) || pageTop(a) - pageTop(b))[0];
  // 吸顶的导航栏滚动后还挂在最上面，会盖住截图，先藏起来
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if ((cs.position === 'fixed' || cs.position === 'sticky') && r.top <= 10 && r.height < 240 && !el.contains(head)) el.style.setProperty('visibility', 'hidden', 'important');
  }
  document.documentElement.style.scrollBehavior = 'auto'; // 网站开了平滑滚动的话，量位置时还没滚到位
  window.scrollTo({top: Math.max(0, pageTop(head) - 70), behavior: 'instant'}); // 把标题滚到画面上方
  // 标题文字实际占的范围（标题元素本身常常是整行宽）
  const range = document.createRange(); range.selectNodeContents(head);
  const hr = range.getBoundingClientRect().width > 50 ? range.getBoundingClientRect() : head.getBoundingClientRect();
  // 标题下面、横向和标题有重叠的正文段落（最多取 4 段）：只看 <p>，没有 <p> 的网站看「只装文字的小块」
  const leafText = el => el.tagName === 'P' || (![...el.children].some(c => /^(DIV|SECTION|ARTICLE|UL|OL|TABLE|P)$/.test(c.tagName)) && len(el) >= 60);
  const paras = [...document.querySelectorAll('p, div')].filter(p => {
    if (!vis(p) || len(p) < 30 || p.contains(head) || !leafText(p)) return false;
    const r = p.getBoundingClientRect();
    const midX = (hr.left + hr.right) / 2, overlap = Math.min(r.right, hr.right) - Math.max(r.left, hr.left);
    // 和标题在同一列：盖住标题中线，或至少一半宽度和标题文字左右重叠；右边热榜、侧栏卡片、左边菜单不算
    return r.top >= hr.bottom - 4 && r.top < hr.bottom + 520 && r.width <= 1000 && ((r.left <= midX && r.right >= midX) || overlap >= r.width * .5);
  }).slice(0, 4);
  const pad = 28;
  let left = hr.left, right = hr.right;
  for (const p of paras) { const r = p.getBoundingClientRect(); left = Math.min(left, r.left); right = Math.max(right, r.right); }
  if (right - left < 600) { const mid = (left + right) / 2; left = mid - 300; right = mid + 300; } // 太窄的话以标题为中心稍微放宽（不放太宽，免得把侧栏带进来）
  const x = Math.max(0, left - pad), y = Math.max(0, hr.top - 14); // 上边距小一点，免得带进网站顶栏的边
  const width = Math.min(innerWidth - x, right - left + pad * 2);
  const height = Math.min(innerHeight - y, Math.round(width * 0.6)); // 横图，接近视频里配图框的比例
  if (width < 480 || height < 260) return null;
  return {x: x + scrollX, y: y + scrollY, width, height}; // 截图工具要的是整个网页里的坐标，不是当前屏幕里的
}

export async function screenshotPages(jobs, {chromePath}) {
  if (!jobs.length) return;
  let browser;
  try { browser = await launchBrowser({chromePath, width: 1280, height: 860}); } catch (e) { log('截图浏览器启动失败：' + e.message); return; }
  try {
    await pool(jobs, 3, async job => {
      let page;
      try {
        page = await openPage(browser, {width: 1280, height: 860});
        await page.goto(job.url, {timeoutMs: 25000});
        await new Promise(r => setTimeout(r, 2500));
        // 藏掉弹窗：cookie 提示、订阅框、贴底横幅、不含正文的大遮罩。（以前会把「高过半屏的固定层」全藏掉，有的网站整个正文就在这种层里，截出来一片空白；也不再锁滚动条，不然滚不到标题）
        await page.eval(`(() => { for (const el of document.querySelectorAll('body *')) { const cs = getComputedStyle(el); if ((cs.position === 'fixed' || cs.position === 'sticky') && (/cookie|consent|banner|gdpr|subscribe|newsletter|modal|popup|dialog/i.test((el.id||'') + ' ' + (el.className||'')) || (el.getBoundingClientRect().height > innerHeight * .5 && !el.querySelector('h1, article, main')) || cs.bottom === '0px')) el.style.setProperty('display','none','important'); } document.documentElement.style.scrollbarWidth='none'; window.scrollTo(0,0); return true; })()`, {awaitPromise: false}).catch(() => {});
        await new Promise(r => setTimeout(r, 400));
        // 只截「新闻标题 + 开头几段正文」：网站的导航栏、左边菜单、右边热榜都在正文区域外面，不截进来
        const clip = await page.eval(`(${articleClip.toString()})()`).catch(() => null);
        if (clip) await new Promise(r => setTimeout(r, 500)); // 为了把标题放到画面里可能滚动过，等图片重绘
        const buf = await page.screenshot({format: 'jpeg', quality: 88, ...(clip ? {clip} : {})});
        if (buf.length > 25000) { await fsp.writeFile(job.file, buf); job.ok = true; job.w = clip ? Math.round(clip.width) : 1280; job.h = clip ? Math.round(clip.height) : 860; job.cropped = !!clip; }
      } catch (e) { job.error = e.message; }
      finally { await page?.close(); }
    });
  } finally { await browser.close(); }
}

/** 给写稿用的 GitHub 项目信息（数字都来自 GitHub API 和热榜） */
function githubFacts(s) {
  const r = s.repoInfo;
  const lines = [`仓库：${r.fullName}（https://github.com/${r.fullName}）`];
  if (r.description) lines.push(`一句话介绍（作者写的）：${r.description}`);
  if (r.stars) lines.push(`总 Star 数：${r.stars}（约 ${fmtStars(r.stars)}）`);
  if (r.starsWeek) lines.push(`本周涨星：${r.starsWeek}（GitHub 本周热榜）`);
  if (r.trendingDays) lines.push(`这周上了 ${r.trendingDays} 天 GitHub 每日热榜`);
  if (r.hnPoints) lines.push(`Hacker News 讨论：${r.hnPoints} 分`);
  if (r.language) lines.push(`主要编程语言：${r.language}`);
  if (r.license) lines.push(`开源协议：${r.license}`);
  if (r.topics?.length) lines.push(`标签：${r.topics.join('、')}`);
  if (r.homepage) lines.push(`项目主页：${r.homepage}`);
  if (r.createdAt) lines.push(`创建于：${String(r.createdAt).slice(0, 10)}；最近更新：${String(r.pushedAt || '').slice(0, 10)}`);
  if (r.owner) lines.push(`作者：${r.owner}（${r.ownerType === 'Organization' ? '组织/公司' : '个人'}）`);
  return `【GitHub 项目信息】\n${lines.join('\n')}\n\n${s.readme ? `【README 节选】\n${s.readme}\n\n` : ''}`;
}

// 能当「证据」截图的来源：官方（官网、官方博客、官方推文里的链接、GitHub 仓库页）或一手报道的权威媒体
const OFFICIAL_HOSTS = /(^|\.)(openai\.com|anthropic\.com|claude\.com|google|blog\.google|deepmind\.google|ai\.meta\.com|about\.fb\.com|meta\.com|microsoft\.com|nvidia\.com|apple\.com|x\.ai|mistral\.ai|deepseek\.com|qwen\.ai|aliyun\.com|alibabacloud\.com|minimax(i)?\.(io|com|chat)|moonshot\.(cn|ai)|kimi\.com|zhipuai\.cn|z\.ai|bigmodel\.cn|volcengine\.com|bytedance\.com|tencent\.com|baidu\.com|huggingface\.co|github\.com|perplexity\.ai|cursor\.com|home\.cern|[a-z0-9-]+\.gov)$/i;
const TRUSTED_MEDIA = /(^|\.)(wsj\.com|reuters\.com|bloomberg\.com|ft\.com|nytimes\.com|washingtonpost\.com|apnews\.com|bbc\.(com|co\.uk)|cnbc\.com|axios\.com|theinformation\.com|theverge\.com|techcrunch\.com|arstechnica\.com|technologyreview\.com|wired\.com|semafor\.com)$/i;
const REPOST_SITES = /(^|\.)(36kr\.com|ithome\.com|qbitai\.com|techmeme\.com|news\.ycombinator\.com|reddit\.com|smol\.ai)$/i;
function isEvidenceSource(t) {
  const h = host(t.url);
  if (REPOST_SITES.test(h)) return false;
  return ['official', 'release'].includes(t.kind) || t.site === '推文链接' || OFFICIAL_HOSTS.test(h) || TRUSTED_MEDIA.test(h);
}

export async function enrich(stories, {runDir, cfg}) {
  const mediaDir = path.join(runDir, 'media'); await fsp.mkdir(mediaDir, {recursive: true});
  const shots = [];
  await pool(stories, 6, async s => {
    const ordered = pickPrimary(s.items);
    s.primary = ordered[0];
    s.sources = [];
    const texts = [];
    // official tweet (shown as a translated tweet card) + the links inside it
    const tw = s.items.find(i => i.tweet && !i.tweet.isRetweet && i.kind === 'official') || s.items.find(i => i.tweet && !i.tweet.isRetweet);
    let fetchList = ordered.slice(0, 3);
    // GitHub 项目（每周 GitHub 板块）：用 GitHub API 拿 Star、语言、README；只抓仓库页（截图用），HN/Reddit 帖子不抓
    let readmeImgs = [];
    if (cfg.column?.mode === 'github') s.repo = s.repo || s.items.map(i => repoOf(i.url)).find(Boolean) || s.items.flatMap(i => [...(i.ghRepos || []), ...reposIn(i.summary)])[0];
    if (s.repo && cfg.column?.mode === 'github') {
      const self = s.items.find(i => repoOf(i.url) === s.repo) || {title: s.repo, url: `https://github.com/${s.repo}`, sourceName: 'GitHub', kind: 'trending', summary: ''};
      s.primary = {...self, kind: 'trending'};
      fetchList = [s.primary];
      try {
        const info = await repoInfo(s.repo);
        s.repoInfo = {...info, readmeRaw: undefined, starsWeek: s.heat?.ghStarsWeek || 0, trendingDays: s.heat?.ghTrendingDays || 0, hnPoints: s.heat?.hnPoints || 0, redditScore: s.heat?.redditScore || 0};
        if (info.fullName) { s.repo = info.fullName.toLowerCase(); s.primary.url = info.url || s.primary.url; }
        s.readme = readmeText(info.readmeRaw);
        readmeImgs = readmeImages(info.readmeRaw || '', info);
      } catch (e) { s.repoInfo = {fullName: s.repo, error: e.message, starsWeek: s.heat?.ghStarsWeek || 0, stars: s.heat?.ghStars || 0}; log(`GitHub 资料没拿到（${s.repo}）：${e.message}`); }
    }
    if (tw) {
      s.tweet = {...tw.tweet, date: tw.date, url: tw.url};
      const linkItems = (tw.tweet.links || []).slice(0, 1).map(u => ({title: '推文中的链接', url: u, sourceName: '推文链接', kind: tw.kind, summary: ''}));
      fetchList = [...linkItems, ...ordered.filter(i => i !== tw)].slice(0, 3);
      if (s.primary === tw && linkItems.length) s.primary = {...tw, url: tw.url};
    }
    // Techmeme 优先读 RSS 留下的原文地址；旧数据没地址就只留摘要，不抓当天汇总页。
    for (const original of fetchList) {
      const it = /(^|\.)techmeme\.com$/i.test(host(original.url)) && original.origUrl ? {...original, url: original.origUrl, sourceName: host(original.origUrl), kind: 'media'} : original;
      if (it !== original && s.primary === original) s.primary = it;
      const src = {title: it.title, url: it.url, site: it.sourceName, kind: it.kind, date: it.date, summary: it.summary};
      if (!/(^|\.)techmeme\.com$/i.test(host(it.url)) && !SKIP_FETCH.test(host(it.url)) && !/\.(pdf|zip)$/i.test(it.url)) {
        try {
          const {text: html, url: finalUrl} = await fetchText(it.url, {timeoutMs: 18000, retries: 0});
          const a = extractArticle(html, finalUrl);
          src.article = a; src.url = finalUrl;
          if (a.published && !src.date) src.date = a.published;
        } catch (e) { src.fetchError = e.message; }
      }
      s.sources.push(src);
      texts.push(src);
    }
    // 顺藤摸瓜：36氪、IT之家这类转载报道只是线索。这条新闻还没有官方或一手来源时，顺着转载文章里的「原文链接」去读官方原文，
    // 放到第一位当主来源（写稿、来源说明、截图都优先用它）。找不到就保持原样（选题规则里这类新闻本来就不选）。
    if (!s.repoInfo && !s.sources.some(t => t.article && isEvidenceSource(t))) {
      const lead = s.sources.find(t => !/(^|\.)techmeme\.com$/i.test(host(t.url)) && t.article?.links?.length);
      for (const u of lead?.article.links.slice(0, 2) || []) {
        try {
          const {text: html, url: finalUrl} = await fetchText(u, {timeoutMs: 18000, retries: 0});
          const a = extractArticle(html, finalUrl);
          if (!a.text || a.text.length < 200) continue;
          const src = {title: a.title, url: finalUrl, site: `${a.siteName || host(finalUrl)}（从${lead.site}的报道找到的原文）`, kind: OFFICIAL_HOSTS.test(host(finalUrl)) ? 'official' : 'media', date: a.published, article: a};
          s.sources.unshift(src); texts.unshift(src); s.primary = {...s.primary, title: a.title, url: finalUrl, sourceName: src.site, kind: src.kind};
          log(`${s.id}：从${lead.site}的报道找到原文 ${host(finalUrl)}`);
          break;
        } catch {}
      }
    }
    // facts text for the writer
    s.facts = (s.repoInfo ? githubFacts(s) : '') + (s.tweet ? `【官方推文】@${s.tweet.handle}（${s.tweet.name}）${s.tweet.date ? '｜' + String(s.tweet.date).slice(0, 16).replace('T', ' ') + ' UTC' : ''}\n${s.tweet.text}\n\n` : '') + texts.map((t, i) => `【来源${i + 1}】${t.site}｜${t.url}${t.date ? '｜' + String(t.date).slice(0, 10) : ''}\n标题：${t.article?.title || t.title}\n${t.article?.description ? '摘要：' + t.article.description + '\n' : ''}${t.summary && !t.article ? '摘要：' + t.summary.slice(0, 800) + '\n' : ''}${t.article?.text && !(s.readme && t === s.sources[0]) ? '正文节选：' + t.article.text.slice(0, i === 0 ? 3500 : 1500) : ''}`).join('\n\n');
    // visuals
    s.media = [];
    const imgUrls = [...readmeImgs]; // GitHub 项目：README 里的产品截图、演示动图最有用，放最前
    for (const t of s.sources) { if (t.article?.image) imgUrls.push(t.article.image); }
    for (const it of s.items) if (it.image) imgUrls.push(it.image);
    for (const t of s.sources) for (const u of t.article?.images || []) imgUrls.push(u);
    // 多收几张候选（s.mediaExtra），写稿后由 AI 看图挑（imagecheck.mjs）；前 maxMedia 张先放进 s.media，AI 看图关掉或失败时就用它们
    const maxMedia = maxMediaFor(s), maxCands = maxMedia > 0 ? Math.min(5, maxMedia + 3) : 0;
    s.mediaExtra = [];
    let n = 0;
    for (const u of [...new Set(imgUrls)]) {
      if (s.media.length + s.mediaExtra.length >= maxCands) break;
      if (/pbs\.twimg\.com\/profile_images|abs\.twimg\.com/.test(u)) continue;
      try { const img = await saveImage(u, path.join(mediaDir, `${s.id}-img${n++}`)); (s.media.length < maxMedia ? s.media : s.mediaExtra).push({...img, kind: 'image', url: u}); } catch {}
    }
    // 原文页面截图一律留一张当备选：网站的「分享封面图」常是资料图或装饰插画，截图里至少能看到这条新闻的标题。
    // 截图在画面上相当于「证据」，只用官方来源（官网/官方博客/官方推文里的链接）或一手报道的权威媒体；
    // 36氪、IT之家、量子位、Techmeme 这类转载/聚合网站可以给写稿当参考，但不截图。
    const shotSrc = s.sources.find(t => t.article && isEvidenceSource(t) && !SKIP_FETCH.test(host(t.url)));
    if (shotSrc && maxMedia > 0) shots.push({story: s, url: shotSrc.url, file: path.join(mediaDir, `${s.id}-shot.jpg`)});
  });
  if (cfg.enrich?.screenshots !== false) {
    await screenshotPages(shots, {chromePath: cfg.render?.chromePath});
    for (const j of shots) if (j.ok) (j.story.media.length < maxMediaFor(j.story) ? j.story.media : j.story.mediaExtra).push({file: j.file, w: j.w || 1280, h: j.h || 860, kind: 'screenshot', url: j.url, cropped: !!j.cropped});
  }
  const withMedia = stories.filter(s => s.media.length).length;
  log(`原文与配图：${stories.length} 条中 ${withMedia} 条有配图`);
  await writeJson(path.join(runDir, 'enriched.json'), stories.map(s => ({id: s.id, chapter: s.chapter, workingTitle: s.workingTitle, primary: s.primary?.url, sources: s.sources.map(x => ({url: x.url, site: x.site, date: x.date, fetchError: x.fetchError})), media: s.media, factsLength: s.facts.length, ...(s.repoInfo ? {repo: s.repo, repoInfo: s.repoInfo} : {})})));
  return stories;
}
