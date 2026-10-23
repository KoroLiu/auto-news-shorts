// Every library module loads (catches syntax errors and broken imports). Entry scripts with side effects are only syntax-checked.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const src = new URL('../src/', import.meta.url);
const ENTRY = new Set(['main.mjs', 'setup.mjs', path.join('workbench', 'server.mjs')]);
const files = fs.readdirSync(src, {recursive: true}).filter(f => f.endsWith('.mjs'));

for (const f of files) {
  test(`module ${f}`, async () => {
    const file = new URL(f.split(path.sep).join('/'), src);
    if (ENTRY.has(f)) assert.equal(spawnSync(process.execPath, ['--check', file.pathname.replace(/^\/([A-Za-z]:)/, '$1')]).status, 0);
    else await import(file);
  });
}
