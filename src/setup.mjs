// First-time setup / environment check: Node, ffmpeg, Chrome, Python + edge-tts, logo icon pack, TTS smoke test.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {ROOT, run, log, exists, loadConfig, findFfmpeg, readJson, writeJson} from './util.mjs';
import {findPython, synthesize} from './tts/tts.mjs';
import {findChrome} from './render/cdp.mjs';

const ok = m => log('✅ ' + m), bad = m => log('❌ ' + m), warn = m => log('⚠️ ' + m);

async function main() {
  const cfg = loadConfig();
  const localPath = path.join(ROOT, 'config.local.json');
  const local = await readJson(localPath, {});
  let problems = 0;

  // Node
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) ok('Node.js ' + process.versions.node); else { bad(`Node.js 版本 ${process.versions.node} 太旧，请安装 22 以上`); problems++; }

  // ffmpeg
  const {ffmpeg} = findFfmpeg(cfg);
  const f = await run(ffmpeg, ['-version'], {timeoutMs: 20000});
  if (f.code === 0) ok('ffmpeg：' + ffmpeg); else { bad('找不到 ffmpeg（请在 config.local.json 设置 render.ffmpegPath）'); problems++; }

  // Chrome
  try { const c = findChrome(cfg.render?.chromePath); ok('浏览器：' + c); local.render = {...(local.render || {}), chromePath: c}; } catch (e) { bad(e.message); problems++; }

  // Python + edge-tts
  try {
    const py = await findPython(cfg);
    ok('Python：' + [py.exe, ...py.pre].join(' '));
    local.tts = {...(local.tts || {}), python: py.exe};
    let r = await run(py.exe, [...py.pre, '-m', 'pip', 'install', '-U', 'edge-tts'], {timeoutMs: 5 * 60 * 1000});
    if (r.code !== 0) { warn('官方源安装失败，改用清华镜像…'); r = await run(py.exe, [...py.pre, '-m', 'pip', 'install', '-U', 'edge-tts', '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'], {timeoutMs: 5 * 60 * 1000}); }
    if (r.code === 0) ok('edge-tts 已安装'); else { bad('edge-tts 安装失败：' + (r.err || r.out).slice(-400)); problems++; }
  } catch (e) { bad(e.message); problems++; }


  // 封面上的 AI 公司 logo（开源图标库 @lobehub/icons-static-svg，MIT）：没有也能出封面，只是 logo 变成首字圆标
  const lobe = path.join(ROOT, 'tools', 'lobe-icons');
  if (!exists(path.join(lobe, 'icons'))) {
    const tmp = path.join(ROOT, 'tools', '_lobe'); await fsp.mkdir(tmp, {recursive: true});
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const p = await run(npm, ['pack', '@lobehub/icons-static-svg', '--pack-destination', process.platform === 'win32' ? `"${tmp}"` : tmp], {cwd: tmp, timeoutMs: 3 * 60 * 1000, shell: process.platform === 'win32'});
    const tgz = fs.readdirSync(tmp).find(f => f.endsWith('.tgz'));
    if (p.code === 0 && tgz && (await run('tar', ['xzf', tgz], {cwd: tmp, timeoutMs: 60000})).code === 0) {
      await fsp.rm(lobe, {recursive: true, force: true}); await fsp.rename(path.join(tmp, 'package'), lobe); ok('封面 logo 图标库已下载');
    } else warn('封面 logo 图标库没下载成功（封面照常能出，logo 用首字圆标）');
    await fsp.rm(tmp, {recursive: true, force: true});
  } else ok('封面 logo 图标库');

  // GPT-SoVITS (only if selected)
  const tts = {...cfg.tts, ...(local.tts || {})};
  if (tts.provider === 'gptsovits') {
    const g = tts.gptsovits || {};
    if (g.dir && exists(path.join(g.dir, 'api_v2.py'))) ok('GPT-SoVITS 目录：' + g.dir); else { bad('GPT-SoVITS 目录没设置好：在 config.json 的 tts.gptsovits.dir 填整合包解压后的文件夹'); problems++; }
    try { const {findVoicePack} = await import('./tts/tts.mjs'); const v = findVoicePack(g.voice); ok(`声音包：${path.basename(v.dir)}（参考音频文字：${v.refText}）`); } catch (e) { bad(e.message); problems++; }
  } else ok('配音引擎：' + (tts.provider || 'edge（微软晓晓，免费）'));

  // LLM key (needed for topic selection and writing)
  const {checkLlmConfig} = await import('./llm.mjs');
  const llmErr = checkLlmConfig(cfg);
  if (llmErr) { bad(llmErr + '（见 README「Quick start」）'); problems++; } else ok('AI 接口：' + (process.env.LLM_BASE_URL || cfg.llm?.baseUrl) + ' / ' + (process.env.LLM_MODEL || cfg.llm?.model));

  await writeJson(localPath, local);

  // TTS smoke test
  try {
    const outDir = path.join(ROOT, 'runs', 'voice-samples');
    await synthesize([{id: 'setup-test', sentences: [{text: '大家好，这里是每日AI资讯，声音测试成功。'}]}], {cfg: {...cfg, tts: {...cfg.tts, ...local.tts}}, outDir});
    ok('配音测试成功：' + path.join(outDir, 'setup-test.mp3'));
  } catch (e) { bad('配音测试失败：' + e.message.slice(0, 500)); problems++; }

  log(problems ? `有 ${problems} 项需要处理（见上面 ❌）` : '🎉 环境全部就绪！');
}
main().catch(e => { bad(e.stack || e.message); process.exitCode = 1; });
