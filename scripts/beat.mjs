#!/usr/bin/env node
/**
 * beat.mjs — 从音频里找出"可卡点的击打时刻"
 *
 * 思路：不迷信 BPM。真实曲子常有半拍/倍频歧义，均分网格会越走越偏。
 * 卡点的物理含义是"音乐在这里重击了一下"，所以直接检测击打瞬间：
 *   低频带能量（踢鼓）+ 全带能量 → 起音强度 → 峰值挑选 → 去重
 * 同时给出 BPM 估值，仅供文案节奏参考。
 *
 * 用法：
 *   node scripts/beat.mjs --audio assets/bgm/vibe.mp3 --out assets/beats.json
 *
 * 输出（beats.json）：
 *   { bpm, duration, onsets: [秒...], strong: [秒...], density }
 *   strong = 能量前 1/3 的击打点，做分屏切换首选
 *
 * 退出码：0 成功 / 1 失败
 */

import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const AUDIO = path.resolve(arg('audio', 'assets/bgm/vibe.mp3'));
const OUT = path.resolve(arg('out', 'assets/beats.json'));
const SR = 22050;
const FRAME = 1024;   // ≈46ms
const HOP = 256;      // ≈11.6ms → fps ≈ 86

if (!existsSync(AUDIO)) {
  console.error(`[beat] 找不到音频 ${AUDIO}`);
  process.exit(1);
}

const decode = (file) => new Promise((resolve, reject) => {
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const chunks = []; let err = '';
  p.stdout.on('data', d => chunks.push(d));
  p.stderr.on('data', d => { err += d.toString(); });
  p.on('close', code => {
    if (code !== 0) return reject(new Error(err.slice(-400) || `ffmpeg 退出码 ${code}`));
    const b = Buffer.concat(chunks);
    const n = b.length >> 1;
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = b.readInt16LE(i * 2) / 32768;
    resolve(s);
  });
  p.on('error', reject);
});

const sig = await decode(AUDIO);
const dur = sig.length / SR;
const frames = Math.floor((sig.length - FRAME) / HOP);
const fps = SR / HOP;

// ---- 两条包络：低频（踢鼓/贝斯）与全带 ----
const lowEnv = new Float64Array(frames);
const allEnv = new Float64Array(frames);
const a = 0.02; // 一阶低通 ≈ 70Hz，专抓底鼓
let lp = 0;
for (let f = 0; f < frames; f++) {
  let lo = 0, hi = 0;
  const off = f * HOP;
  for (let i = 0; i < FRAME; i++) {
    const v = sig[off + i];
    lp += a * (v - lp);
    lo += lp * lp;
    hi += v * v;
  }
  lowEnv[f] = Math.log(1e-12 + lo / FRAME);
  allEnv[f] = Math.log(1e-12 + hi / FRAME);
}

// 起音强度 = 半波整流的一阶差分
const fluxOf = (env) => {
  const o = new Float64Array(frames);
  for (let f = 1; f < frames; f++) {
    const d = env[f] - env[f - 1];
    o[f] = d > 0 ? d : 0;
  }
  return o;
};
const raw = fluxOf(lowEnv);
const rawAll = fluxOf(allEnv);

// 用中位数/高分位做稳健归一化：满编母带里个别大瞬态不该吃掉全部量程
const robust = (arr) => {
  const s = Float64Array.from(arr).sort();
  const p50 = s[frames >> 1];
  const p97 = s[Math.floor(frames * 0.97)];
  const span = p97 - p50 || 1;
  return Float64Array.from(arr, v => Math.max(0, Math.min(3, (v - p50) / span)));
};
const L = robust(raw);
const A = robust(rawAll);
const mix = new Float64Array(frames);
for (let f = 0; f < frames; f++) mix[f] = 0.65 * L[f] + 0.35 * A[f];

// ---- 峰值挑选：局部极大 + 最小间隔 ----
const MIN_GAP = 0.22;   // 两击之间至少 220ms（对应最快约 270BPM 的十六分音）
const peaks = [];
for (let f = 2; f < frames - 2; f++) {
  const v = mix[f];
  if (v < 0.35) continue;
  if (v >= mix[f - 1] && v >= mix[f + 1] && v >= mix[f - 2] && v >= mix[f + 2]) {
    peaks.push({ t: f / fps, s: v });
  }
}
peaks.sort((x, y) => x.t - y.t);
const onsets = [];
for (const p of peaks) {
  if (!onsets.length || p.t - onsets[onsets.length - 1] > MIN_GAP) onsets.push(p.t);
  else if (p.s > (peaks.find(q => Math.abs(q.t - onsets[onsets.length - 1]) < 1e-6)?.s || 0)) {
    onsets[onsets.length - 1] = p.t;  // 同一击打取更强的那一帧
  }
}
const scores = peaks.filter(p => onsets.some(t => Math.abs(t - p.t) < 1e-6)).map(p => p.s);
const sortedScores = [...scores].sort((x, y) => x - y);
const cut = sortedScores[Math.floor(sortedScores.length * 0.67)] ?? 0;
const strong = onsets.filter((_, i) => scores[i] >= cut);

// ---- BPM 估值：用重拍间隔的中位数，比自相关更能反映实际听感
function estimateBpm() {
  const gaps = strong.slice(1).map((t, i) => t - strong[i]).sort((x, y) => x - y);
  if (!gaps.length) return null;
  let beat = gaps[gaps.length >> 1];
  while (beat < 0.34) beat *= 2;   // 太碎（十六分音）往上归一到拍
  while (beat > 1.0) beat /= 2;
  return Math.round(60 / beat);
}

const bpm = estimateBpm();
const data = {
  audio: path.basename(AUDIO),
  duration: +dur.toFixed(2),
  bpm,
  fps: +fps.toFixed(1),
  onsets: onsets.map(t => +t.toFixed(3)),
  strong: strong.map(t => +t.toFixed(3)),
  density: +(onsets.length / dur).toFixed(2),
};

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(data), 'utf8');

const gaps = onsets.slice(1).map((t, i) => t - onsets[i]);
gaps.sort((x, y) => x - y);
console.log(JSON.stringify({
  ok: true, bpm, duration: data.duration,
  onsets: onsets.length, strong: strong.length,
  density: data.density,
  medianGap: +(gaps[gaps.length >> 1] || 0).toFixed(3),
  firstStrong: strong.slice(0, 8),
  out: OUT,
}));
