/**
 * A cheerful, royalty-free music bed, synthesized once when the image is built: marimba-like plucks arpeggiating
 * I–V–vi–IV in C major at 116 bpm, a soft bass and a light shaker. 24 bars (about 50 s), looped under longer videos.
 *
 *   node music.mjs bed.wav
 */
import { writeFileSync } from "node:fs";

const SR = 48000;
const BPM = 116;
const beat = 60 / BPM;
const bars = 24;
const dur = bars * 4 * beat;
const n = Math.ceil(dur * SR);
const left = new Float32Array(n + SR);
const right = new Float32Array(n + SR);
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
const hz = (m) => 440 * 2 ** ((m - 69) / 12);

function add(t0, length, sample, panL, panR) {
  const i0 = Math.floor(t0 * SR);
  const k = Math.floor(length * SR);
  for (let j = 0; j < k && i0 + j < left.length; j++) {
    const s = sample(j / SR);
    left[i0 + j] += s * panL;
    right[i0 + j] += s * panR;
  }
}
function pluck(t0, midi, gain, pan = 0, bright = 1) {
  const f = hz(midi);
  add(t0, 1.2, (t) => {
    const env = Math.exp(-t * 7) * (1 - Math.exp(-t * 900));
    const tone = Math.sin(2 * Math.PI * f * t)
      + 0.35 * bright * Math.sin(2 * Math.PI * 3.98 * f * t) * Math.exp(-t * 28)
      + 0.12 * Math.sin(2 * Math.PI * 2 * f * t) * Math.exp(-t * 12);
    return tone * env * gain;
  }, (1 - pan) / 1.4, (1 + pan) / 1.4);
}
function bass(t0, midi, length, gain) {
  const f = hz(midi);
  add(t0, length, (t) => (Math.sin(2 * Math.PI * f * t) + 0.2 * Math.sin(4 * Math.PI * f * t)) * Math.min(1, t * 60) * Math.exp(-t * 2.2) * gain, 0.7, 0.7);
}
function shaker(t0, gain) {
  let prev = 0;
  add(t0, 0.07, (t) => {
    const x = rand();
    const s = (x - prev) * Math.exp(-t * 60) * gain;
    prev = x;
    return s;
  }, 0.8, 1);
}

const chords = [[48, [60, 64, 67, 72]], [43, [59, 62, 67, 71]], [45, [60, 64, 69, 72]], [41, [60, 65, 69, 72]]];
const pattern = [0, 1, 2, 3, 2, 1, 2, 3];
const melody = [76, null, 79, 76, 74, null, 72, null, 74, null, 76, 74, 72, null, 69, null];
for (let bar = 0; bar < bars; bar++) {
  const [root, tones] = chords[bar % 4];
  const t = bar * 4 * beat;
  bass(t, root, 2 * beat, 0.32);
  bass(t + 2 * beat, root, 1.6 * beat, 0.24);
  bass(t + 3.5 * beat, root + 12, 0.5 * beat, 0.14);
  pattern.forEach((idx, e) => pluck(t + (e * beat) / 2, tones[idx], e % 2 ? 0.11 : 0.16, -0.3 + 0.2 * (idx % 2)));
  for (let e = 0; e < 8; e++) shaker(t + (e * beat) / 2 + (e % 2 ? 0.02 : 0), e % 2 ? 0.05 : 0.028);
  if (bar >= 4 && bar % 4 !== 1) {
    const phrase = melody.slice((bar % 2) * 8, (bar % 2) * 8 + 8);
    phrase.forEach((m, e) => {
      if (m !== null) pluck(t + (e * beat) / 2, bar % 8 >= 6 ? m + 12 : m, 0.08, 0.35, 1.6);
    });
  }
}

let peak = 0;
for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
const data = Buffer.alloc(n * 4);
for (let i = 0; i < n; i++) {
  data.writeInt16LE(Math.round((left[i] / peak) * 0.8 * 32767), i * 4);
  data.writeInt16LE(Math.round((right[i] / peak) * 0.8 * 32767), i * 4 + 2);
}
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + data.length, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(2, 22);
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 4, 28);
header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(data.length, 40);
writeFileSync(process.argv[2] || "bed.wav", Buffer.concat([header, data]));
console.log(`music bed ${dur.toFixed(1)} s`);
