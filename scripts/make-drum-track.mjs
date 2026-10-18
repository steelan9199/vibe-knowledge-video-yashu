#!/usr/bin/env node
/**
 * make-drum-track.mjs — 合成一条"鼓点真值已知"的基准音轨
 *
 * 为什么需要它：vibe.mp3 是持续噪声/氛围垫音，低频是连续能量墙，
 * 没有底鼓瞬态、没有稳定 tempo（实测 kick 自相关 r≈0.03–0.09，段间 BPM 从 74 跳到 234），
 * 用它根本无法验证"动画是否卡在鼓点上"。
 *
 * 这条轨道把答案写死：96 BPM，four-on-the-floor，每拍一个 kick，
 * 2/4 拍加军鼓，八分音符 hihat。鼓点时间 = k * 0.625s，精确到采样点。
 * 输出：
 *   assets/bgm/drum96.mp3      60s 音轨
 *   assets/beats-drum96.json   与 beat.mjs 同格式的击打点表（真值）
 *
 * 用法：node scripts/make-drum-track.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const SR = 44100;
const BPM = 96;
const BEAT = 60 / BPM;        // 0.625s
const BARS = 24;              // 24 小节 = 96 拍 = 60s
const TOTAL_BEATS = BARS * 4;
const DUR = TOTAL_BEATS * BEAT;
const N = Math.round(DUR * SR);

const L = new Float32Array(N);
const R = new Float32Array(N);

// 确定性噪声（避免每次生成不同）
let seed = 20261018;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };

const add = (t0, dur, fn, gain = 1, pan = 0) => {
  const i0 = Math.round(t0 * SR);
  const n = Math.round(dur * SR);
  const gl = gain * Math.cos((pan + 1) * Math.PI / 4);
  const gr = gain * Math.sin((pan + 1) * Math.PI / 4);
  for (let i = 0; i < n; i++) {
    const j = i0 + i;
    if (j < 0 || j >= N) continue;
    const v = fn(i / SR, i);
    L[j] += v * gl;
    R[j] += v * gr;
  }
};

// ---------------- 乐器 ----------------
// kick：音高快速下滑（120→45Hz）+ 短 click，衰减 0.28s
const kick = (t0) => {
  let ph = 0;
  add(t0, 0.32, (t) => {
    const f = 45 + 75 * Math.exp(-t / 0.032);
    ph += 2 * Math.PI * f / SR;
    const body = Math.sin(ph) * Math.exp(-t / 0.155);
    const click = (t < 0.008 ? rnd() * (1 - t / 0.008) * 0.45 : 0);
    return Math.tanh((body + click) * 1.25);
  }, 0.95);
};

// snare：噪声 + 185Hz 体
const snare = (t0) => {
  let ph = 0;
  add(t0, 0.22, (t) => {
    ph += 2 * Math.PI * 185 / SR;
    const nz = rnd() * Math.exp(-t / 0.075) * 0.85;
    const tone = Math.sin(ph) * Math.exp(-t / 0.055) * 0.45;
    return Math.tanh((nz + tone) * 1.1);
  }, 0.5, 0.08);
};

// hihat：一阶差分当高通，衰减 0.035s
let prevIn = 0;
const hat = (t0, open = false) => {
  add(t0, open ? 0.22 : 0.07, (t) => {
    const x = rnd();
    const hp = x - prevIn; prevIn = x;
    return hp * Math.exp(-t / (open ? 0.085 : 0.028));
  }, open ? 0.13 : 0.16, -0.22);
};

// bass：正弦 + 二次谐波，慢起
const bass = (t0, freq, dur) => {
  let ph = 0;
  add(t0, dur, (t) => {
    ph += 2 * Math.PI * freq / SR;
    const env = Math.min(1, t / 0.012) * Math.exp(-t / (dur * 0.55));
    return (Math.sin(ph) + 0.28 * Math.sin(2 * ph)) * env;
  }, 0.34);
};

// pad：三和弦，柔起柔收
const pad = (t0, freq, dur) => {
  const voices = [1, 1.2, 1.5, 2];
  const phs = voices.map(() => 0);
  add(t0, dur, (t) => {
    const atk = Math.min(1, t / 0.35);
    const rel = Math.min(1, Math.max(0, (dur - t) / 0.5));
    let s = 0;
    voices.forEach((m, i) => { phs[i] += 2 * Math.PI * freq * m / SR; s += Math.sin(phs[i]) / (i + 1.6); });
    return s * atk * rel;
  }, 0.085, 0.3);
};

// ---------------- 编排 ----------------
// Am – F – C – G，每 2 小节一换
const PROG = [
  { bass: 55.00, pad: 110.00 }, // Am
  { bass: 43.65, pad: 87.31 },  // F
  { bass: 65.41, pad: 130.81 }, // C
  { bass: 49.00, pad: 98.00 },  // G
];

for (let bar = 0; bar < BARS; bar++) {
  const barT = bar * 4 * BEAT;
  const chord = PROG[Math.floor(bar / 2) % 4];

  for (let b = 0; b < 4; b++) {
    const t = barT + b * BEAT;
    kick(t);                                    // four-on-the-floor：每拍一个底鼓
    if (b === 1 || b === 3) snare(t);           // 2、4 拍军鼓
    hat(t, false);
    hat(t + BEAT / 2, b === 3);                 // 八分音符 hihat
  }

  // 贝斯：每小节两下（第 1、3 拍）
  bass(barT, chord.bass, BEAT * 1.6);
  bass(barT + BEAT * 2, chord.bass, BEAT * 1.4);
  // pad：每 2 小节一次长音
  if (bar % 2 === 0) pad(barT, chord.pad, BEAT * 8);
}

// ---------------- 母带 ----------------
let peak = 0;
for (let i = 0; i < N; i++) {
  const l = Math.tanh(L[i] * 1.05);
  const r = Math.tanh(R[i] * 1.05);
  L[i] = l; R[i] = r;
  peak = Math.max(peak, Math.abs(l), Math.abs(r));
}
const norm = 0.89 / (peak || 1);
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);

for (let i = 0; i < N; i++) {
  const l = Math.max(-1, Math.min(1, L[i] * norm));
  const r = Math.max(-1, Math.min(1, R[i] * norm));
  buf.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(r * 32767), 44 + i * 4 + 2);
}

const wavPath = path.join(ROOT, 'out', '_drum96.wav');
const mp3Path = path.join(ROOT, 'assets', 'bgm', 'drum96.mp3');
const beatsPath = path.join(ROOT, 'assets', 'beats-drum96.json');

await mkdir(path.dirname(wavPath), { recursive: true });
await writeFile(wavPath, buf);

await new Promise((resolve, reject) => {
  const p = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', wavPath,
    '-codec:a', 'libmp3lame', '-b:a', '192k', mp3Path], { stdio: 'ignore', windowsHide: true });
  p.on('close', c => (c === 0 ? resolve() : reject(new Error('ffmpeg 转码失败'))));
  p.on('error', reject);
});

// 真值：每拍一个 kick；每拍都是"重击"，切屏首选
const kicks = Array.from({ length: TOTAL_BEATS }, (_, k) => +(k * BEAT).toFixed(4));
const beats = {
  audio: 'drum96.mp3',
  duration: +DUR.toFixed(2),
  bpm: BPM,
  fps: +(SR / 512).toFixed(1),
  onsets: kicks,
  strong: kicks,
  density: +(TOTAL_BEATS / DUR).toFixed(2),
  source: 'synthesized',
  note: 'four-on-the-floor：每拍 1 个 kick，2/4 拍加 snare，八分音符 hihat。时间为真值。',
};
await writeFile(beatsPath, JSON.stringify(beats), 'utf8');

console.log(JSON.stringify({
  ok: true, audio: mp3Path, beats: beatsPath,
  bpm: BPM, beat: BEAT, beats: TOTAL_BEATS, duration: +DUR.toFixed(2),
}, null, 2));
