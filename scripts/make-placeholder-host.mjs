// Draws the neutral placeholder host (a simple silhouette, no character) into assets/host/placeholder/.
// Run once: node scripts/make-placeholder-host.mjs  (needs Chrome/Edge; see docs/custom-host.md for the file list)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {findChrome} from '../src/render/cdp.mjs';
import {loadConfig} from '../src/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets', 'host', 'placeholder');
const BODY = '#8ea4c8', LINE = '#4d5f80', FACE = '#e9eef7';

// mouth: 0 closed, 1 half open, 2 open; blink: eyes closed. arm: none | point | thumb | open | side
function figure({w, h, mouth = 0, blink = false, arm = 'none', lean = false}) {
  const cx = w / 2, headR = Math.min(w, h) * 0.16, headY = h * 0.27;
  const eyes = blink
    ? `<path d="M${cx - headR * .42} ${headY - headR * .05} h${headR * .26} M${cx + headR * .16} ${headY - headR * .05} h${headR * .26}" stroke="${LINE}" stroke-width="${headR * .07}" stroke-linecap="round"/>`
    : `<circle cx="${cx - headR * .3}" cy="${headY - headR * .08}" r="${headR * .09}" fill="${LINE}"/><circle cx="${cx + headR * .3}" cy="${headY - headR * .08}" r="${headR * .09}" fill="${LINE}"/>`;
  const mouthEl = mouth === 0
    ? `<path d="M${cx - headR * .22} ${headY + headR * .38} q${headR * .22} ${headR * .14} ${headR * .44} 0" stroke="${LINE}" stroke-width="${headR * .07}" fill="none" stroke-linecap="round"/>`
    : `<ellipse cx="${cx}" cy="${headY + headR * .4}" rx="${headR * .2}" ry="${headR * (mouth === 1 ? .1 : .2)}" fill="${LINE}"/>`;
  const sh = headY + headR * 1.25, bw = w * 0.62;
  const torso = `<path d="M${cx - bw / 2} ${h} L${cx - bw / 2} ${sh + headR * .9} Q${cx - bw / 2} ${sh} ${cx - bw * .2} ${sh} L${cx + bw * .2} ${sh} Q${cx + bw / 2} ${sh} ${cx + bw / 2} ${sh + headR * .9} L${cx + bw / 2} ${h} Z" fill="${BODY}" stroke="${LINE}" stroke-width="6"/>`;
  const hand = (x, y) => `<circle cx="${x}" cy="${y}" r="${headR * .28}" fill="${FACE}" stroke="${LINE}" stroke-width="5"/>`;
  const armPath = (x1, y1, x2, y2) => `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="${BODY}" stroke-width="${headR * .5}" stroke-linecap="round"/><path d="M${x1} ${y1} L${x2} ${y2}" stroke="${LINE}" stroke-width="5" stroke-linecap="round" opacity=".35"/>`;
  const ax = cx + bw / 2 - headR * .3, ay = sh + headR * .5;
  const arms = {
    none: '',
    point: armPath(ax, ay, w * .95, sh - headR * .6) + hand(w * .95, sh - headR * .6),
    thumb: armPath(ax, ay, cx + bw * .55, sh + headR * .2) + hand(cx + bw * .55, sh + headR * .2) + `<rect x="${cx + bw * .55 - headR * .07}" y="${sh - headR * .45}" width="${headR * .14}" height="${headR * .45}" rx="${headR * .07}" fill="${FACE}" stroke="${LINE}" stroke-width="4"/>`,
    open: armPath(ax, ay, w * .93, sh + headR * 1.2) + hand(w * .93, sh + headR * 1.2) + armPath(cx - bw / 2 + headR * .3, ay, w * .07, sh + headR * 1.2) + hand(w * .07, sh + headR * 1.2),
    side: armPath(ax, ay, cx + bw * .5, sh + headR * 2.2) + hand(cx + bw * .5, sh + headR * 2.2),
  }[arm];
  const g = `<g transform="${lean ? `rotate(-6 ${cx} ${h})` : ''}">${torso}${arms}<circle cx="${cx}" cy="${headY}" r="${headR}" fill="${FACE}" stroke="${LINE}" stroke-width="6"/>${eyes}${mouthEl}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${g}</svg>`;
}

const avatar = s => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><rect width="${s}" height="${s}" fill="#dfe6f2"/>${figure({w: s, h: s * 1.6}).replace(/^<svg[^>]*>|<\/svg>$/g, '').replace('<g transform="', `<g transform="translate(0 ${-s * .02}) `)}</svg>`;

const files = {};
for (const [pose, w, h, extra] of [['idle', 605, 1000, {}], ['present', 627, 1000, {arm: 'open'}], ['lean', 787, 900, {lean: true}]]) {
  for (const m of [0, 1, 2]) files[`${pose}-${m}.png`] = figure({w, h, mouth: m, ...extra});
  files[`${pose}-b.png`] = figure({w, h, blink: true, ...extra});
}
Object.assign(files, {
  'point.png': figure({w: 662, h: 1000, arm: 'point'}),
  'thumbs.png': figure({w: 593, h: 1000, arm: 'thumb'}),
  'side.png': figure({w: 637, h: 1000, arm: 'side'}),
  'avatar.png': avatar(320),
  'cover-open.png': figure({w: 720, h: 1135, arm: 'open'}),
  'cover-point.png': figure({w: 720, h: 1076, arm: 'point'}),
  'cover-thumb.png': figure({w: 720, h: 1196, arm: 'thumb'}),
});

fs.mkdirSync(OUT, {recursive: true});
const chrome = findChrome(loadConfig().render?.chromePath);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-'));
for (const [name, svg] of Object.entries(files)) {
  const [w, h] = [svg.match(/width="(\d+)"/)[1], svg.match(/height="(\d+)"/)[1]];
  const html = path.join(tmp, name + '.html');
  fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
  const out = path.join(OUT, name);
  const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000', `--window-size=${w},${h}`, `--screenshot=${out}`, 'file:///' + html.split(path.sep).join('/')], {encoding: 'utf8'});
  if (!fs.existsSync(out)) throw new Error(`failed: ${name} ${r.stderr}`);
  console.log('ok', name, `${w}x${h}`);
}
fs.rmSync(tmp, {recursive: true, force: true});
