#!/usr/bin/env node
/**
 * beat.mjs — 从音频里找出"可卡点的击打时刻"（v2：周期 + 相位联合拟合）
 *
 * v1 的错误（已修）：
 *   - 只挑能量峰，再用峰间隔的中位数当 BPM。峰本身不规律 → BPM 是假的（vibe.mp3 被测成 96，
 *     实际 112.9）。96 与 112.9 差 17%，几十拍之后整体错位半拍以上。
 *   - MIN_GAP=0.22s 允许 272BPM 级别的双触发，导致 onsets 里混入大量假击打。
 *
 * v2 的做法（音乐制作人的标准流程）：
 *   ① 分频段取包络（高频=镲/瞬态，低频=底鼓），各自算起音强度
 *   ② 自相关在 0.4–0.75s（80–150BPM）里找拍长候选——这一段才是"人能跟着点头"的拍
 *   ③ 对每个候选做 period × phase 二维精扫，取"网格点强度 − 半拍强度"最大的
 *   ④ 网格点吸附到 ±25ms 内最近的起音峰（既保证均匀，又不脱离真实击打）
 *   ⑤ 输出 confidence（对比度），低于阈值时明确警告"这首歌没有可用的节拍"
 *
 * 用法：
 *   node scripts/beat.mjs --audio assets/bgm/vibe.mp3 --out assets/beats.json
 *   node scripts/beat.mjs --audio x.mp3 --strong-every 16   # 每 16 拍一个重拍（8.5s 圈）
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
const STRONG_EVERY = Math.max(1, Number(arg('strong-every', 4)) || 4);
const BPM_LO = Number(arg('bpm-min', 80));
const BPM_HI = Number(arg('bpm-max', 150));
const SR = 22050;
const FRAME = 512;
const HOP = 128;           // 5.8ms 分辨率
const FPS = SR / HOP;

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
const frames = Math.floor((sig.length - FRAME) / HOP) + 1;

// ---------------- 频段 ----------------
// 两级一阶低通 = 12dB/oct
const lp2 = (cut) => {
  const a = 1 - Math.exp(-2 * Math.PI * cut / SR);
  const y = new Float32Array(sig.length);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < sig.length; i++) { s1 += a * (sig[i] - s1); s2 += a * (s1 - s2); y[i] = s2; }
  return y;
};
const lp90 = lp2(90);
const lp2k = lp2(2000);

const envLow = new Float64Array(frames);
const envHigh = new Float64Array(frames);
const envAll = new Float64Array(frames);
for (let f = 0; f < frames; f++) {
  const o = f * HOP;
  let lo = 0, hi = 0, al = 0;
  for (let i = 0; i < FRAME; i++) {
    const v = sig[o + i];
    const l = lp90[o + i];
    const h = v - lp2k[o + i];
    lo += l * l; hi += h * h; al += v * v;
  }
  envLow[f] = Math.log(1e-12 + lo / FRAME);
  envHigh[f] = Math.log(1e-12 + hi / FRAME);
  envAll[f] = Math.log(1e-12 + al / FRAME);
}

const fluxOf = (env) => {
  const o = new Float64Array(frames);
  for (let f = 1; f < frames; f++) { const d = env[f] - env[f - 1]; o[f] = d > 0 ? d : 0; }
  const s = Float64Array.from(o).sort();
  const p50 = s[frames >> 1], p97 = s[Math.floor(frames * 0.97)] || 1;
  const span = (p97 - p50) || 1;
  return Float64Array.from(o, v => Math.max(0, Math.min(5, (v - p50) / span)));
};
const FH = fluxOf(envHigh);
const FL = fluxOf(envLow);
const FA = fluxOf(envAll);

// 综合起音强度：高频瞬态是节拍最可靠的指标（混响对高频影响小、attack 最陡）。
// 低频只做少量加权——持续 bass / drone 的缓慢起伏会把自相关带偏（vibe.mp3 就是这样被判成 87BPM）。
const mix = new Float64Array(frames);
for (let f = 0; f < frames; f++) mix[f] = 0.75 * FH[f] + 0.15 * FL[f] + 0.10 * FA[f];

const sample = (t) => {
  const x = t * FPS, i = Math.floor(x);
  if (i < 0 || i >= frames - 1) return 0;
  const u = x - i;
  return mix[i] * (1 - u) + mix[i + 1] * u;
};

// ---------------- ① 自相关找候选拍长 ----------------
const mean = (() => { let m = 0; for (let f = 0; f < frames; f++) m += mix[f]; return m / frames; })();
const acAt = (lag) => {
  let z = 0, s = 0;
  for (let f = 0; f + lag < frames; f++) { z += (mix[f] - mean) ** 2; s += (mix[f] - mean) * (mix[f + lag] - mean); }
  return z ? s / z : 0;
};
const lagLo = Math.round(FPS * 60 / BPM_HI);
const lagHi = Math.round(FPS * 60 / BPM_LO);
const acCurve = [];
for (let lag = lagLo; lag <= lagHi; lag++) acCurve.push({ lag, period: lag / FPS, r: acAt(lag) });
const acPeaks = acCurve.filter((p, i) => i > 0 && i < acCurve.length - 1 && p.r >= acCurve[i - 1].r && p.r >= acCurve[i + 1].r)
  .sort((a, b) => b.r - a.r).slice(0, 6);

// ---------------- ② period × phase 精扫 ----------------
function evalGrid(period, t0 = 0, t1 = dur, phaseSteps = 160, arr = FH) {
  // 用高频起音强度定相位：混响会把低频包络拖后，高频 attack 才是"这一下"的物理起点
  const smp = arr === mix ? sample : (t) => {
    const x = t * FPS, i = Math.floor(x);
    if (i < 0 || i >= frames - 1) return 0;
    const u = x - i;
    return arr[i] * (1 - u) + arr[i + 1] * u;
  };
  let best = { score: -1, phase: 0 };
  for (let s = 0; s < phaseSteps; s++) {
    const ph = (s / phaseSteps) * period;
    let sum = 0, c = 0;
    const k0 = Math.ceil((t0 - ph) / period);
    for (let k = k0; ph + k * period < t1; k++) { sum += smp(ph + k * period); c++; }
    if (c && sum / c > best.score) best = { score: sum / c, phase: ph };
  }
  let off = 0, c2 = 0;
  const k0 = Math.ceil((t0 - best.phase) / period);
  for (let k = k0; best.phase + k * period + period / 2 < t1; k++) { off += smp(best.phase + k * period + period / 2); c2++; }
  best.half = c2 ? off / c2 : 0;
  best.contrast = best.score - best.half;
  best.period = period;
  return best;
}

const cands = [];
for (const p of acPeaks) {
  for (let d = -0.012; d <= 0.0121; d += 0.0015) {
    const period = p.period + d;
    if (period < 60 / BPM_HI || period > 60 / BPM_LO) continue;
    cands.push(evalGrid(period, 0, dur, 80));
  }
}
if (!cands.length) {
  console.error('[beat] 没有找到候选拍长，这条音频可能没有稳定节拍');
  process.exit(1);
}
cands.sort((a, b) => b.contrast - a.contrast);
const best = cands[0];

// 拍长置信度：网格点强度 / 半拍强度，>1.25 才算"能听见拍"
const ratio = best.half > 1e-6 ? best.score / best.half : 99;

// ---------------- ③ 生成网格并吸附 ----------------
const period = best.period;
const beats = [];
for (let t = best.phase; t < dur - 0.02; t += period) beats.push(t);

// 吸附到 ±25ms 内最近的真实起音峰（保持均匀，但不脱离击打）
const snapped = beats.map(t => {
  let bestT = t, bestV = sample(t);
  for (let d = -0.025; d <= 0.0251; d += 0.0058) {
    const v = sample(t + d);
    if (v > bestV) { bestV = v; bestT = t + d; }
  }
  return bestT;
});

const strong = snapped.filter((_, i) => i % STRONG_EVERY === 0);

const data = {
  audio: path.basename(AUDIO),
  duration: +dur.toFixed(2),
  bpm: +(60 / period).toFixed(2),
  period: +period.toFixed(5),
  phase: +best.phase.toFixed(4),
  fps: +FPS.toFixed(1),
  onsets: snapped.map(t => +t.toFixed(3)),
  strong: strong.map(t => +t.toFixed(3)),
  density: +(snapped.length / dur).toFixed(2),
  strongEvery: STRONG_EVERY,
  onGrid: +best.score.toFixed(3),
  halfBeat: +best.half.toFixed(3),
  contrast: +best.contrast.toFixed(3),
  ratio: +ratio.toFixed(2),
};

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(data), 'utf8');

const gaps = snapped.slice(1).map((t, i) => t - snapped[i]);
console.log(JSON.stringify({
  ok: true,
  bpm: data.bpm, period: data.period, phase: data.phase,
  beats: data.onsets.length, strong: data.strong.length,
  onGrid: data.onGrid, halfBeat: data.halfBeat, ratio: data.ratio,
  medianGapMs: +(gaps.sort((a, b) => a - b)[gaps.length >> 1] * 1000).toFixed(1),
  confidence: ratio >= 1.25 ? 'good' : 'low',
  warning: ratio < 1.25 ? '网格点并不比半拍明显更强：这条音频可能没有可用的节拍' : undefined,
  out: OUT,
}, null, 2));
