// Text model access. provider: codex (Codex CLI logged in on this PC) | antigravity (agy CLI) | openai (any OpenAI-compatible API).
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {run, log, exists} from './util.mjs';


function findFiles(base, re, depth) {
  const out = [];
  (function walk(d, k) {
    if (k > depth || out.length > 5) return;
    let ents; try { ents = fs.readdirSync(d, {withFileTypes: true}); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/^(node_modules|\.git|cache|Cache|logs|temp|tmp)$/.test(e.name)) walk(p, k + 1); }
      else if (re.test(e.name)) out.push(p);
    }
  })(base, 0);
  return out;
}

let codexSpec = null;
/** Locate the Codex CLI even when it is not on PATH (npm global, Codex desktop app, custom npm prefix). */
export async function findCodex(cfg = {}) {
  if (codexSpec) return codexSpec;
  const cands = [];
  if (cfg.llm?.codexPath) cands.push(cfg.llm.codexPath);
  cands.push('codex');
  if (process.platform === 'win32') {
    const w = await run('where', ['codex'], {timeoutMs: 10000});
    cands.push(...w.out.split(/\r?\n/).map(x => x.trim()).filter(Boolean));
    const np = await run('npm.cmd', ['prefix', '-g'], {shell: true, timeoutMs: 30000});
    const prefix = np.out.trim().split(/\r?\n/).pop();
    const A = process.env.APPDATA || '', L = process.env.LOCALAPPDATA || '', U = process.env.USERPROFILE || '';
    for (const pre of [prefix, path.join(A, 'npm'), path.join(U, '.agent-reach', 'tools', 'npm')].filter(Boolean))
      cands.push(path.join(pre, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), path.join(pre, 'codex.cmd'));
    for (const base of [path.join(L, 'Programs'), path.join(L, 'OpenAI'), path.join(U, '.codex'), path.join(A, 'Codex'), path.join(L, 'Codex')]) cands.push(...findFiles(base, /^codex(\.exe)?$/i, 5));
  }
  for (const c of [...new Set(cands)]) {
    if (c !== 'codex' && !exists(c)) continue;
    const spec = /\.js$/i.test(c) ? {command: process.execPath, prefix: [c], shell: false, path: c}
      : /\.cmd$/i.test(c) ? {command: c, prefix: [], shell: true, path: c} : {command: c, prefix: [], shell: false, path: c};
    const r = await run(spec.command, [...spec.prefix, '--version'], {timeoutMs: 30000, shell: spec.shell});
    if (r.code === 0 && /\d+\.\d+/.test(r.out + r.err)) { codexSpec = {...spec, version: (r.out + r.err).trim().split(/\r?\n/)[0]}; return codexSpec; }
  }
  return null;
}

function quoteWin(a) { return /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a; }

async function codexExec(prompt, schema, {workDir, timeoutMs, model, executable, images = [], effort}) {
  await fsp.mkdir(workDir, {recursive: true});
  const id = crypto.randomUUID().slice(0, 8);
  const schemaFile = path.join(workDir, `schema-${id}.json`);
  const outFile = path.join(workDir, `answer-${id}.json`);
  await fsp.writeFile(schemaFile, JSON.stringify(schema));
  await fsp.writeFile(path.join(workDir, `prompt-${id}.txt`), prompt);
  const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--output-schema', schemaFile, '--output-last-message', outFile];
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  for (const f of images) args.push(`--image=${f}`); // 用 = 写法：--image 能吃多个值，不然会把后面的 "-" 也当成图片
  args.push('-');
  const spec = await findCodex({llm: {codexPath: executable}});
  if (!spec) throw new Error('找不到 Codex CLI。请确认已安装并登录（或在 config.local.json 填 llm.codexPath / 改用 llm.provider=openai）');
  const full = [...spec.prefix, ...args];
  const r = await run(spec.command, spec.shell ? full.map(quoteWin) : full, {cwd: workDir, input: prompt, timeoutMs, shell: spec.shell});
  // Codex 会把整篇提示词也打进 stderr，只截末尾会看不到真正的报错，所以优先挑出带 error 的行
  if (r.code !== 0 || r.killed) {
    const errLines = (r.err || r.out).split(/\r?\n/).filter(x => /^\s*(error|ERROR|Error)\b|stream error|rate limit|usage limit/.test(x)).join('\n');
    throw new Error(`Codex 调用失败 (exit=${r.code}${r.killed ? ', 超时' : ''}): ${(errLines || (r.err || r.out)).slice(-1500)}`);
  }
  const text = await fsp.readFile(outFile, 'utf8');
  return parseJsonLoose(text);
}

// Antigravity CLI（agy）：用 Antigravity 登录的账号额度（如 Claude Sonnet 4.6）。
// 提示词可能有 5 万多字，超过 Windows 命令行长度上限，所以走 stream-json 从标准输入喂进去。
function findAgy(executable) {
  const c = [executable, path.join(process.env.USERPROFILE || '', '.gemini', 'bin', 'agy.exe')].filter(Boolean);
  return c.find(exists) || 'agy';
}

async function agyExec(prompt, schema, {workDir, timeoutMs, model, effort, executable}) {
  await fsp.mkdir(workDir, {recursive: true});
  const id = crypto.randomUUID().slice(0, 8);
  const full = `${prompt}\n\n【输出要求】直接回答，不要调用任何工具，不要读写文件、不要上网。只输出一个符合下面 JSON Schema 的 JSON 对象，前后不要有任何其他文字或代码块标记；字符串内容里需要引号时用中文引号“”或「」，不要用英文双引号：\n${JSON.stringify(schema)}`;
  await fsp.writeFile(path.join(workDir, `prompt-${id}.txt`), full);
  const args = ['--model', model || 'claude-sonnet-4-6', '--input-format', 'stream-json', '--output-format', 'stream-json', '--sandbox'];
  if (effort) args.push('--effort', effort);
  const input = JSON.stringify({event: 'user', message: {content: full}}) + '\n';
  const r = await run(findAgy(executable), args, {cwd: workDir, input, timeoutMs});
  const result = r.out.split(/\r?\n/).map(l => { try { return JSON.parse(l); } catch { return null; } }).find(e => e?.event === 'result')?.result;
  if (!result || result.status !== 'SUCCESS' || r.killed) throw new Error(`Antigravity 调用失败 (exit=${r.code}${r.killed ? ', 超时' : ''}): ${result?.error || (r.err || r.out).slice(-1500)}`);
  await fsp.writeFile(path.join(workDir, `answer-${id}.json`), result.response);
  return parseJsonLoose(result.response);
}

// API key lookup: llm.apiKey (config.local.json) → env var named by llm.apiKeyEnv → env LLM_API_KEY.
// On Windows, a user env var set after this program started is read from the registry.
function envOrRegistry(name) {
  if (process.env[name]) return process.env[name];
  if (process.platform === 'win32') {
    const r = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], {encoding: 'utf8'});
    const m = /REG_(?:EXPAND_)?SZ\s+(\S+)/.exec(r.stdout || '');
    if (m) return m[1];
  }
  return '';
}
function readApiKey(l) {
  const key = l.apiKey || (l.apiKeyEnv && envOrRegistry(l.apiKeyEnv)) || envOrRegistry('LLM_API_KEY');
  if (key) return key;
  throw new Error(`找不到 AI 接口密钥：请设置环境变量 LLM_API_KEY${l.apiKeyEnv && l.apiKeyEnv !== 'LLM_API_KEY' ? `（或 ${l.apiKeyEnv}）` : ''}，或在 config.local.json 填 llm.apiKey`);
}

/** config.llm with env overrides applied: LLM_BASE_URL, LLM_MODEL. */
export function resolveLlm(cfg) {
  const l = {...(cfg.llm || {})};
  if (process.env.LLM_BASE_URL) l.baseUrl = process.env.LLM_BASE_URL;
  if (process.env.LLM_MODEL) l.model = process.env.LLM_MODEL;
  return l;
}

/** Fail fast before collecting: returns a Chinese error message, or null when the text model looks usable. */
export function checkLlmConfig(cfg) {
  const l = resolveLlm(cfg);
  if ((l.provider || 'openai') !== 'openai') return null; // codex / antigravity check themselves when called
  if (!l.baseUrl || !l.model) return 'AI 接口没配置好：请在 config.json 的 llm 里填 baseUrl 和 model（或设置环境变量 LLM_BASE_URL、LLM_MODEL）';
  try { readApiKey(l); return null; } catch (e) { return e.message; }
}

// 用流式返回（stream）：思考强度 max 时一批 5 条要想 5 分钟以上；非流式要等全部想完才回响应头，
// Node's fetch gives up after ~300 s waiting for response headers ("fetch failed"); streaming keeps the connection alive.
async function openaiChat(prompt, schema, {baseUrl, apiKey, model, effort, timeoutMs}) {
  const res = await fetch(baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: {'content-type': 'application/json', authorization: `Bearer ${apiKey}`},
    body: JSON.stringify({model, temperature: 0.4, stream: true, response_format: {type: 'json_object'}, ...(effort ? {reasoning_effort: effort} : {}),
      messages: [{role: 'system', content: '你是严谨的中文 AI 科技新闻编辑。只输出符合要求的 JSON。JSON Schema:\n' + JSON.stringify(schema)}, {role: 'user', content: prompt}]}),
  });
  if (!res.ok) throw new Error(`LLM API HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const dec = new TextDecoder();
  let buf = '', text = '', thinking = 0, finish = '', usage = null;
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, {stream: true});
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
      const j = JSON.parse(line.slice(5));
      if (j.error) throw new Error(`LLM API 出错: ${JSON.stringify(j.error).slice(0, 500)}`);
      const c = j.choices?.[0];
      text += c?.delta?.content || '';
      thinking += (c?.delta?.reasoning_content || '').length;
      if (c?.finish_reason) finish = c.finish_reason;
      if (j.usage) usage = j.usage;
    }
  }
  if (!text.trim()) throw new Error(`模型没给出正文（结束原因 ${finish || '连接中断'}，思考了 ${thinking} 字，用量 ${JSON.stringify(usage)}）`);
  return parseJsonLoose(text);
}

export function parseJsonLoose(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('模型输出不是 JSON: ' + t.slice(0, 300));
}

/** Ask the configured model for JSON matching `schema`. Retries once on failure. */
export async function askJson(prompt, schema, {cfg, workDir, label = 'llm', timeoutMs = 20 * 60 * 1000}) {
  const l = resolveLlm(cfg);
  try { return await askOnce(prompt, schema, {l, provider: l.provider || 'openai', workDir, label, timeoutMs}); }
  catch (e) {
    // Optional fallback provider (llm.fallback) when the main one fails twice.
    if (!l.fallback || l.fallback === (l.provider || 'openai')) throw e;
    log(`${label}: ${l.provider} 失败，改用备用 ${l.fallback}`);
    return askOnce(prompt, schema, {l: {...l, model: l.fallbackModel}, provider: l.fallback, workDir, label, timeoutMs});
  }
}

/** OpenAI-compatible vision settings: llm.vision, or env LLM_VISION_MODEL; baseUrl and key default to the text model's. */
function visionCfg(cfg) {
  const l = resolveLlm(cfg), v = {...(l.vision || {})};
  if (process.env.LLM_VISION_MODEL) v.model = process.env.LLM_VISION_MODEL;
  if (!v.model) return null;
  return {baseUrl: v.baseUrl || l.baseUrl, model: v.model, apiKey: v.apiKey || l.apiKey, apiKeyEnv: v.apiKeyEnv || l.apiKeyEnv};
}

/** A vision model is configured (llm.vision / LLM_VISION_MODEL) or the provider is the Codex CLI. */
export const visionAvailable = cfg => !!visionCfg(cfg)?.baseUrl || cfg.llm?.provider === 'codex';

const MIME = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif'};
async function openaiVision(prompt, schema, images, {baseUrl, apiKey, model, timeoutMs}) {
  const parts = [{type: 'text', text: prompt}];
  for (const f of images) parts.push({type: 'image_url', image_url: {url: `data:${MIME[path.extname(f).toLowerCase()] || 'image/jpeg'};base64,${(await fsp.readFile(f)).toString('base64')}`}});
  const res = await fetch(baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: {'content-type': 'application/json', authorization: `Bearer ${apiKey}`},
    body: JSON.stringify({model, temperature: 0.2, response_format: {type: 'json_object'},
      messages: [{role: 'system', content: '只输出符合要求的 JSON。JSON Schema:\n' + JSON.stringify(schema)}, {role: 'user', content: parts}]}),
  });
  if (!res.ok) throw new Error(`Vision API HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const j = await res.json();
  return parseJsonLoose(j.choices?.[0]?.message?.content || '');
}

/** Ask a model about images (used to pick relevant pictures). llm.vision (OpenAI-compatible) first, else Codex CLI. Retries on failure. */
export async function askVision(prompt, schema, images, {cfg, workDir, label = 'vision', timeouts = [90, 120, 180].map(s => s * 1000)}) {
  const l = cfg.llm || {};
  const v = visionCfg(cfg);
  if (v?.baseUrl) {
    const apiKey = readApiKey(v);
    let lastErr;
    for (let attempt = 1; attempt <= timeouts.length; attempt++) {
      try { return await openaiVision(prompt, schema, images, {baseUrl: v.baseUrl, apiKey, model: v.model, timeoutMs: timeouts[attempt - 1]}); }
      catch (e) { lastErr = e; log(`${label}: 第 ${attempt} 次失败 → ${String(e.message).slice(0, 300)}`); }
    }
    throw lastErr;
  }
  const model = l.visionModel || ((l.provider || 'codex') === 'codex' ? l.model : undefined);
  let lastErr;
  // Image calls sometimes hang on the first try; a retry usually succeeds, so the first wait is short
  for (let attempt = 1; attempt <= timeouts.length; attempt++) {
    const t = Date.now(), timeoutMs = timeouts[attempt - 1];
    // 看图不需要深度思考，默认 low（快很多）；config 里 llm.visionEffort 可改
    try { const out = await codexExec(prompt, schema, {workDir, timeoutMs, model, executable: l.codexPath, images, effort: l.visionEffort || 'low'}); log(`${label}: 完成 (${((Date.now() - t) / 1000).toFixed(0)}s)`); return out; }
    catch (e) { lastErr = e; log(`${label}: 第 ${attempt} 次失败 → ${String(e.message).slice(0, 300)}`); }
  }
  throw lastErr;
}

async function askOnce(prompt, schema, {l, provider, workDir, label, timeoutMs}) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t = Date.now();
    try {
      const out = provider === 'openai'
        // reasoning effort "max" sometimes thinks until the output budget runs out; the retry uses "high"
        ? await openaiChat(prompt, schema, {baseUrl: l.baseUrl, apiKey: readApiKey(l), model: l.model, effort: attempt === 2 && l.reasoningEffort === 'max' ? 'high' : l.reasoningEffort, timeoutMs})
        : provider === 'antigravity'
          ? await agyExec(prompt, schema, {workDir, timeoutMs, model: l.agyModel, effort: l.agyEffort, executable: l.agyPath})
          : await codexExec(prompt, schema, {workDir, timeoutMs, model: l.model, executable: l.codexPath});
      log(`${label}: 完成 (${((Date.now() - t) / 1000).toFixed(0)}s)`);
      return out;
    } catch (e) {
      lastErr = e; log(`${label}: 第 ${attempt} 次失败 → ${String(e.message).slice(0, 300)}`);
      // 服务器忙（503/429/high traffic）时等一分钟再重试
      if (attempt === 1 && /\b(503|429)\b|UNAVAILABLE|high traffic|capacity/i.test(e.message)) await new Promise(r => setTimeout(r, 60000));
    }
  }
  throw lastErr;
}

/** Run async tasks with limited concurrency. */
export async function pool(items, limit, fn) {
  const res = new Array(items.length); let i = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); } }));
  return res;
}
