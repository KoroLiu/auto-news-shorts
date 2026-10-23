// Offline: export package + weekly GitHub de-duplication. No AI, TTS, or rendering.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {exportPackage, isExported, shortTitle} from '../src/export.mjs';
import {recentRepos} from '../src/github.mjs';

const info = {
  title: '【MyChannel】70%！新模型成本大降，开发者已经可以用上了', shortHook: '70%！新模型成本大降',
  desc: '简介', tags: ['AI', '大模型'], toc: ['00:05  新模型'],
  chapters: [{from: 0, to: 5, content: '开场'}, {from: 5, to: 65, content: '新模型'}],
};

async function fakeRun() {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ans-export-'));
  for (const f of ['v.mp4', 'c.jpg', 'cp.jpg']) await fs.writeFile(path.join(runDir, f), 'x');
  return runDir;
}

test('exportPackage writes all five files', async () => {
  const runDir = await fakeRun();
  const dir = await exportPackage({runDir, info, video: path.join(runDir, 'v.mp4'), coverLandscape: path.join(runDir, 'c.jpg'), coverPortrait: path.join(runDir, 'cp.jpg')});
  assert.equal(dir, path.join(runDir, 'package'));
  for (const f of ['video.mp4', 'cover-landscape.jpg', 'cover-portrait.jpg', 'metadata.json', 'metadata.txt'])
    await fs.access(path.join(dir, f));
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8'));
  assert.ok(Array.isArray(meta.tags));
  assert.match(meta.chapters[0].time, /^\d\d:\d\d$/);
  assert.equal(meta.chapters[1].time, '00:05');
  assert.equal(meta.platformTitles.bilibili, info.title);
  assert.ok(meta.platformTitles.xiaohongshu.length <= 20);
  assert.ok(!meta.platformTitles.xiaohongshu.startsWith('【'));
  const txt = await fs.readFile(path.join(dir, 'metadata.txt'), 'utf8');
  assert.ok(txt.includes(info.title) && txt.includes('00:05'));
});

test('exportPackage writes exported.json', async () => {
  const runDir = await fakeRun();
  assert.equal(isExported(runDir), false);
  await exportPackage({runDir, info, video: path.join(runDir, 'v.mp4'), coverLandscape: path.join(runDir, 'c.jpg'), coverPortrait: path.join(runDir, 'cp.jpg')});
  assert.equal(isExported(runDir), true);
});

test('exportPackage tolerates a missing portrait cover', async () => {
  const runDir = await fakeRun();
  const dir = await exportPackage({runDir, info, video: path.join(runDir, 'v.mp4'), coverLandscape: path.join(runDir, 'c.jpg'), coverPortrait: path.join(runDir, 'nope.jpg')});
  await assert.rejects(fs.access(path.join(dir, 'cover-portrait.jpg')));
  await fs.access(path.join(dir, 'metadata.json'));
});

test('shortTitle falls back to the short hook when the full title is too long', () => {
  assert.equal(shortTitle(info, 30), '【MyChannel】70%！新模型成本大降');
  assert.equal(shortTitle(info, 20, {noSign: true}), '70%！新模型成本大降');
});

test('recentRepos counts only exported runs', async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ans-runs-'));
  const col = {id: 'github', runSuffix: 'github'};
  const mk = async (name, repo, exported) => {
    const dir = path.join(runsDir, name);
    await fs.mkdir(dir, {recursive: true});
    await fs.writeFile(path.join(dir, 'stories-written.json'), JSON.stringify([{repo}]));
    if (exported) await fs.writeFile(path.join(dir, 'exported.json'), '{}');
  };
  await mk('2026-10-18-github', 'a/exported', true);
  await mk('2026-10-11-github', 'b/not-exported', false);
  const got = recentRepos(col, '2026-10-25', {runsDir});
  assert.deepEqual([...got.keys()], ['a/exported']);
});
