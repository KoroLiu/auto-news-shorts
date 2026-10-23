// 生成正片开头的「咔哒」声 public/sfx/click.wav：两个快速衰减的正弦波叠加（2300 Hz + 1100 Hz，0.12 秒），自己合成，没有版权问题。
import fs from 'node:fs';
const rate = 48000, n = Math.round(rate * .12), data = Buffer.alloc(n * 2);
for (let i = 0; i < n; i++) {
  const t = i / rate;
  const v = .55 * (.75 * Math.sin(2 * Math.PI * 2300 * t) * Math.exp(-170 * t) + .5 * Math.sin(2 * Math.PI * 1100 * t) * Math.exp(-90 * t));
  data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), i * 2);
}
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
h.write('data', 36); h.writeUInt32LE(data.length, 40);
fs.writeFileSync(new URL('../public/sfx/click.wav', import.meta.url), Buffer.concat([h, data]));
console.log('ok');
