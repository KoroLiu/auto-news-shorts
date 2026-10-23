// Remotion step must accept the audio format of every TTS engine (Edge writes .mp3, Qwen3/GPT-SoVITS write .wav).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {segmentAudio, shellQuote} from '../src/render/remotion.mjs';

// Windows runs npx through a shell, which splits unquoted arguments at spaces
test('shellQuote keeps paths with spaces in one argument', () => {
  assert.equal(shellQuote('runs\\2026-01-31-My AI News.mp4'), '"runs\\2026-01-31-My AI News.mp4"');
  assert.equal(shellQuote('--props=my folder\\props.json'), '"--props=my folder\\props.json"');
  assert.equal(shellQuote('DailyPortrait'), 'DailyPortrait');
});

function runWith(files) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ans-audio-'));
  fs.mkdirSync(path.join(runDir, 'audio'));
  for (const f of files) fs.writeFileSync(path.join(runDir, 'audio', f), 'x');
  return runDir;
}

test('segmentAudio finds the Edge mp3', () => {
  const runDir = runWith(['intro.mp3']);
  assert.equal(segmentAudio(runDir, 'intro'), path.join(runDir, 'audio', 'intro.mp3'));
});

test('segmentAudio prefers wav when both exist', () => {
  const runDir = runWith(['s1.mp3', 's1.wav']);
  assert.equal(segmentAudio(runDir, 's1'), path.join(runDir, 'audio', 's1.wav'));
});

test('segmentAudio throws a clear error when audio is missing', () => {
  assert.throws(() => segmentAudio(runWith([]), 's2'), /s2/);
});
