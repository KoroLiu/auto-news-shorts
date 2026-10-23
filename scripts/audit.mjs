// Privacy audit before publishing: npm run audit
// - Only files listed in release-files.json may be tracked by git, and every listed file must exist.
// - Every listed file is scanned for local paths, secrets, upload endpoints, e-mail addresses and the
//   private words in .audit-private.txt (one per line; that file is git-ignored and never published).
// Patterns are assembled from pieces so this file does not flag itself.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const j = (...p) => p.join('');
const RULES = [
  // drive-letter paths: a letter, a colon, a slash (standard install folders such as Program Files are allowed)
  {rule: 'local-path', re: /(^|["'`=\s(])[A-Za-z]:[\\/](?!Program Files)/},
  {rule: 'local-path', re: /\/(Users|home)\/[^/\s'"]+\/(Desktop|Documents|AppData)/},
  {rule: 'secret', re: new RegExp(j('sk', '-[A-Za-z0-9]{16,}'))},
  {rule: 'secret', re: new RegExp(j('SESS', 'DATA|bili', '_jct|access', '_token=|refresh', '_token='), 'i')},
  {rule: 'upload-endpoint', re: new RegExp(j('member\\.', 'bilibili\\.com|creator\\.', 'douyin\\.com|cp\\.', 'kuaishou\\.com|channels\\.', 'weixin\\.qq\\.com|creator\\.', 'xiaohongshu\\.com'), 'i')},
  {rule: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/, skip: f => path.basename(f) === 'LICENSE' || f === 'package-lock.json'},
];
const BINARY = /\.(exe|dll|so|dylib|mp4|mov|mkv|webm|wav|mp3|m4a|flac|ogg|aac|zip|7z|tgz|pyc)$/i;
const TEXT = /\.(mjs|js|cjs|ts|tsx|json|md|html|css|py|txt|yml|yaml|cmd|ps1|sh)$|^(LICENSE|\.gitignore|\.gitattributes|\.prettierrc|\.env\.example)$/i;

/** Scan `files` (paths relative to root). Returns {ok, hits: [{file, line, rule}]}. */
export function audit({root, files, privateWords = []}) {
  const hits = [];
  const words = privateWords.map(w => w.trim()).filter(Boolean);
  for (const f of files) {
    if (BINARY.test(f)) { hits.push({file: f, line: 0, rule: 'binary'}); continue; }
    if (!TEXT.test(path.basename(f))) continue;
    const lines = fs.readFileSync(path.join(root, f), 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      for (const r of RULES) if (!r.skip?.(f) && r.re.test(text)) hits.push({file: f, line: i + 1, rule: r.rule});
      for (const w of words) if (text.toLowerCase().includes(w.toLowerCase())) hits.push({file: f, line: i + 1, rule: 'private-word'});
    });
  }
  return {ok: hits.length === 0, hits};
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const listed = JSON.parse(fs.readFileSync(path.join(root, 'release-files.json'), 'utf8'));
  const problems = [];
  for (const f of listed) if (!fs.existsSync(path.join(root, f))) problems.push(`listed but missing: ${f}`);
  const tracked = spawnSync('git', ['ls-files', '-z'], {cwd: root, encoding: 'utf8'}).stdout.split('\0').filter(Boolean);
  const set = new Set(listed);
  for (const f of tracked) if (!set.has(f)) problems.push(`tracked but not in release-files.json: ${f}`);
  const privFile = path.join(root, '.audit-private.txt');
  const privateWords = fs.existsSync(privFile) ? fs.readFileSync(privFile, 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')) : [];
  if (!privateWords.length) console.log('⚠️ .audit-private.txt not found or empty: only generic rules are checked. Put your own name, handles, channel names etc. there (one per line).');
  const {hits} = audit({root, files: listed.filter(f => fs.existsSync(path.join(root, f))), privateWords});
  for (const h of hits) problems.push(`${h.file}:${h.line}  ${h.rule}`); // the matched text is not printed, so private words stay off screen
  if (problems.length) { console.log(problems.join('\n')); console.log(`❌ audit failed: ${problems.length} problem(s)`); process.exit(1); }
  console.log(`✅ audit ok: ${listed.length} files, ${privateWords.length} private words checked`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
