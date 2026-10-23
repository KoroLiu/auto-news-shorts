// Offline: generic config, env overrides, helpful errors. No network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {checkLlmConfig, resolveLlm} from '../src/llm.mjs';
import {synthesize} from '../src/tts/tts.mjs';

const missingEnv = 'ANS_TEST_MISSING_KEY_' + process.pid;

test('checkLlmConfig returns error when key missing', () => {
  const saved = process.env.LLM_API_KEY; delete process.env.LLM_API_KEY;
  try {
    const err = checkLlmConfig({llm: {provider: 'openai', baseUrl: 'https://api.deepseek.com', model: 'm', apiKeyEnv: missingEnv}});
    assert.match(err, /LLM_API_KEY/);
  } finally { if (saved !== undefined) process.env.LLM_API_KEY = saved; }
});

test('checkLlmConfig ok when env set', () => {
  process.env[missingEnv] = 'sk-test';
  try { assert.equal(checkLlmConfig({llm: {provider: 'openai', baseUrl: 'https://api.deepseek.com', model: 'm', apiKeyEnv: missingEnv}}), null); }
  finally { delete process.env[missingEnv]; }
});

test('env LLM_BASE_URL and LLM_MODEL override config', () => {
  process.env.LLM_BASE_URL = 'https://example.test/v1'; process.env.LLM_MODEL = 'other-model';
  try {
    const l = resolveLlm({llm: {provider: 'openai', baseUrl: 'https://api.deepseek.com', model: 'm'}});
    assert.equal(l.baseUrl, 'https://example.test/v1');
    assert.equal(l.model, 'other-model');
  } finally { delete process.env.LLM_BASE_URL; delete process.env.LLM_MODEL; }
});

test('qwen3 without python path throws helpful error', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ans-tts-'));
  await assert.rejects(
    synthesize([{id: 's1', sentences: [{text: '测试。'}]}], {cfg: {tts: {provider: 'qwen3', qwen3: {voice: 'x'}}}, outDir}),
    e => /edge/.test(e.message) && /tts\.qwen3\.python/.test(e.message));
});

test('config.json has no absolute paths', () => {
  const text = fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8');
  assert.equal(text.match(/(^|[^A-Za-z])[A-Za-z]:[\\/]/g), null); // drive-letter paths, not URLs
});
