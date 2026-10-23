// 离线验证：模拟模型回复，不调用 AI、配音、渲染或投稿。
import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {normalizePortrait, CONCLUSION} from '../src/write-portrait.mjs';

const facts = '官方称新模型成本降低70%，面向开发者开放。';
const portrait = {
  tab: '新模型', ribbon: '新模型开放', ribbonSub: '面向开发者',
  hero: {v: '70%', k: '成本降幅', small: '官方公布的数据', evidence: facts},
  chip: null, comment: '新模型已向开发者开放。', stamp: '已开放',
};
// comment/stamp are only kept when render.portrait.conclusion is on
const expected = CONCLUSION ? portrait : {...portrait, comment: '', stamp: ''};

test('有原文依据的数字和结论保留，缺字段的旧稿兼容', () => {
  assert.deepEqual(normalizePortrait(portrait, facts), expected);
  assert.deepEqual(normalizePortrait(undefined, facts), {});
  assert.equal(normalizePortrait({...portrait, hero: null}, facts).hero, null);
});

test('编造数字、伪造引文、部分数字和缺单位的数字不进入画面', () => {
  for (const [v, evidence, source] of [
    ['90%', facts, facts],
    ['70%', '价格降低70%', facts],
    ['70%', '成本降低170%', '成本降低170%'],
    ['70', facts, facts],
  ]) {
    const warnings = [];
    const result = normalizePortrait({...portrait, hero: {...portrait.hero, v, evidence}}, source, x => warnings.push(x));
    assert.equal(result.hero, null);
    assert.equal(warnings.length, 1);
    assert.equal(result.comment, expected.comment);
  }
});

test('超长总结不截断，没有总结就不显示印章', () => {
  const result = normalizePortrait({...portrait, comment: '长'.repeat(33)}, facts);
  assert.equal(result.comment, '');
  assert.equal(result.stamp, '');
});

test('写稿输出及 script.json 保留竖屏内容和原来的标题、口播；不覆盖手工补充', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-portrait-test-'));
  const manual = {s1: {comment: '手工修改优先'}};
  await fs.writeFile(path.join(dir, 'portrait-extra.json'), JSON.stringify(manual));
  const base = {
    skip: false, title: '新模型开放', short: '新模型', sourceLine: '来源 · 官方',
    coverTitle: '新模型开放', hookTitle: '70%！新模型成本降低', hookShort: '70%！成本降低',
    tweetZh: '', tags: ['模型'], cards: [{icon: 'cpu', heading: '成本降低', body: '官方称成本降低70%'}],
    narration: [{text: '官方称新模型成本降低70%。', card: 0}],
  };
  mock.module('../src/llm.mjs', {exports: {
    pool: async (items, limit, fn) => Promise.all(items.map(fn)),
    askJson: async (prompt, schema) => {
      assert.match(prompt, /portrait/);
      assert.ok(schema.properties.stories.items.required.includes('portrait'));
      return {stories: [{...base, id: 's1', portrait}, {...base, id: 's2'}]};
    },
  }});
  try {
    const {writeStories} = await import('../src/write.mjs');
    const stories = await writeStories([{id: 's1', facts}, {id: 's2', facts}], {
      cfg: {}, date: '2026-10-21', workDir: path.join(dir, 'llm'),
    });
    assert.equal(stories.length, 2);
    assert.deepEqual(stories[0].portrait, expected);
    assert.deepEqual(stories[1].portrait, {});
    assert.equal(stories[0].hookTitle, base.hookTitle);
    assert.deepEqual(stories[0].narration, base.narration);
    const script = JSON.parse(await fs.readFile(path.join(dir, 'script.json'), 'utf8'));
    assert.deepEqual(script[0].portrait, expected);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'portrait-extra.json'), 'utf8')), manual);
  } finally {
    mock.restoreAll();
  }
});
