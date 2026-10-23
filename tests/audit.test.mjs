// Privacy audit rules. Sample secrets are assembled at runtime so this file itself passes the audit.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {audit} from '../scripts/audit.mjs';

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ans-audit-'));
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), {recursive: true}); fs.writeFileSync(path.join(root, f), text); }
  return root;
}
const run = (files, privateWords = []) => audit({root: repo(files), files: Object.keys(files), privateWords});
const rules = r => r.hits.map(h => h.rule);

test('flags Windows user path', () => {
  const r = run({'a.mjs': `const p = '${'C'}:\\\\Users\\\\someone\\\\x';`});
  assert.equal(r.ok, false);
  assert.ok(rules(r).includes('local-path'));
});

test('flags drive-letter path but not URLs', () => {
  assert.ok(rules(run({'a.json': `{"python": "${'D'}:/envs/x/python.exe"}`})).includes('local-path'));
  assert.equal(run({'a.json': '{"url": "https://api.example.com/v1"}'}).ok, true);
});

test('flags private word from list', () => {
  const r = run({'README.md': 'made by SecretNick'}, ['SecretNick']);
  assert.deepEqual(r.hits.map(h => [h.file, h.line, h.rule]), [['README.md', 1, 'private-word']]);
});

test('flags api key and login cookie names', () => {
  assert.ok(rules(run({'a.txt': 'key=' + 'sk-' + 'a1b2c3d4e5f6g7h8i9j0'})).includes('secret'));
  assert.ok(rules(run({'a.txt': 'SESS' + 'DATA=abc'})).includes('secret'));
});

test('flags creator endpoint', () => {
  assert.ok(rules(run({'a.mjs': `fetch('https://member.${'bilibili'}.com/x')`})).includes('upload-endpoint'));
});

test('flags email outside LICENSE', () => {
  const mail = 'someone' + '@' + 'example.com';
  assert.ok(rules(run({'a.md': mail})).includes('email'));
  assert.equal(run({'LICENSE': mail}).ok, true);
});

test('flags binaries in the file list', () => {
  assert.ok(rules(run({'tools/x.exe': 'MZ'})).includes('binary'));
});

test('passes clean file', () => {
  assert.deepEqual(run({'a.mjs': 'export const x = 1;\n'}), {ok: true, hits: []});
});

test('private list file itself is gitignored', () => {
  const gi = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(gi, /^\.audit-private\.txt$/m);
});
