// Offline: optional vision check. fetch is stubbed; no real API call.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {visionAvailable, askVision} from '../src/llm.mjs';
import {checkImages} from '../src/imagecheck.mjs';

const keyEnv = 'ANS_TEST_VISION_KEY_' + process.pid;

test('visionAvailable false by default', () => {
  assert.equal(visionAvailable({llm: {provider: 'openai', vision: null}}), false);
  assert.equal(visionAvailable({llm: {provider: 'openai', vision: {baseUrl: 'https://v.test/v1', model: 'vm'}}}), true);
  assert.equal(visionAvailable({llm: {provider: 'codex'}}), true);
});

test('LLM_VISION_MODEL turns the check on and reuses the text endpoint', async () => {
  process.env.LLM_VISION_MODEL = 'deepseek-flash';
  process.env[keyEnv] = 'sk-test';
  const cfg = {llm: {provider: 'openai', baseUrl: 'https://text.test/v1', apiKeyEnv: keyEnv, vision: null}};
  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, opts) => { sent = {url, model: JSON.parse(opts.body).model}; return new Response(JSON.stringify({choices: [{message: {content: '{}'}}]})); };
  try {
    assert.equal(visionAvailable(cfg), true);
    const img = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ans-vision-')), 'a.jpg');
    fs.writeFileSync(img, 'x');
    await askVision('看图', {type: 'object'}, [img], {cfg, workDir: os.tmpdir()});
    assert.deepEqual(sent, {url: 'https://text.test/v1/chat/completions', model: 'deepseek-flash'});
  } finally { globalThis.fetch = realFetch; delete process.env.LLM_VISION_MODEL; delete process.env[keyEnv]; }
});

test('askVision posts image_url parts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ans-vision-'));
  const img = path.join(dir, 'a.png');
  fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  process.env[keyEnv] = 'sk-test';
  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, opts) => {
    sent = {url, body: JSON.parse(opts.body), auth: opts.headers.authorization};
    return new Response(JSON.stringify({choices: [{message: {content: '{"images":[]}'}}]}), {status: 200});
  };
  try {
    const out = await askVision('看图', {type: 'object'}, [img], {cfg: {llm: {provider: 'openai', vision: {baseUrl: 'https://v.test/v1/', model: 'vm', apiKeyEnv: keyEnv}}}, workDir: dir});
    assert.deepEqual(out, {images: []});
    assert.equal(sent.url, 'https://v.test/v1/chat/completions');
    assert.equal(sent.body.model, 'vm');
    assert.equal(sent.auth, 'Bearer sk-test');
    const parts = sent.body.messages.at(-1).content;
    const image = parts.find(p => p.type === 'image_url');
    assert.match(image.image_url.url, /^data:image\/png;base64,/);
  } finally { globalThis.fetch = realFetch; delete process.env[keyEnv]; }
});

test('checkImages skips when unavailable', async () => {
  const stories = [{id: 's1', media: [{file: 'x.png', kind: 'image'}]}];
  const out = await checkImages(stories, {cfg: {llm: {provider: 'openai', vision: null}, enrich: {imageCheck: true}}, workDir: os.tmpdir()});
  assert.deepEqual(out[0].media, [{file: 'x.png', kind: 'image'}]);
  assert.equal(out[0].mediaRejected, undefined);
});
