#!/usr/bin/env node
/**
 * verify-beats.mjs — 独立校验 beats.json 的卡点是否正确
 *
 * 不看 beat.mjs 的算法，只用"音乐制作人"的办法重新量一遍：
 *   ① 三频段包络（低频=底鼓 / 中频=军鼓&人声 / 高频=镲）分别算起音强度
 *   ② 在 60–200 BPM 上做自相关，找真正的拍长（含倍频/半频歧义检查）
 *   ③ 相位搜索：对每个候选 BPM 扫一遍相位，最大化"网格点上的起音强度"
 *   ④ 用拟合出来的网格去量 beats.json：
 *        - 每个 onset / strong 距离最近网格线的偏差
 *        - 每个 onset 处的频段构成（是不是底鼓）
 *        - 漏拍 / 双触发 / 网格漂移
 *
 * 用法：
 *   node scripts/verify-beats.mjs --audio assets/bgm/vibe.mp3 --beats assets/beats.json
 *
 * 退出码：0 = 校验完成（结论看输出）
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const AUDIO = path.resolve(arg('audio', 'assets/bgm/vibe.mp3'));
const BEATS = path.resolve(arg('beats', 'assets/beats.json'));
const SR = 22050;
const FRAME = 1024;
const HOP = 256;
const FPS = SR / HOP;

if (!existsSync(AUDIO)) { console.error(`找不到音频 ${AUDIO}`); process.exit(1); }

// ---------------------------------------------------------------- 解码
const decode = (file) => new Promise((resolve, reject) => {
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const chunks = []; let err = '';
  p.stdout.on('data', d => chunks.push(d));
  p.stderr.on('data', d => { err += d.toString(); });
  p.on('close', code => {
    if (code !== 0) return reject(new Error(err.slice(-400) || `ffmpeg ${code}`));
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
const tOf = f => f / FPS;

// ---------------------------------------------------------------- 三频段包络
// 一阶低通：y += a*(x-y)，截止 ≈ a*SR/(2π)
const lpOf = (a) => {
  const y = new Float32Array(sig.length);
  let s = 0;
  for (let i = 0; i < sig.length; i++) { s += a * (sig[i] - s); y[i] = s; }
  return y;
};
const LOW_A = 0.043;   // ≈150Hz  底鼓（70Hz 会漏掉落在 100–150Hz 的 kick）
const MID_A = 0.35;    // ≈1.5kHz 军鼓 / 人声主体
const lowPass70 = lpOf(LOW_A);
const lowPass1k = lpOf(MID_A);

const band = { low: new Float64Array(frames), mid: new Float64Array(frames), high: new Float64Array(frames), all: new Float64Array(frames) };
for (let f = 0; f < frames; f++) {
  const off = f * HOP;
  let lo = 0, mid = 0, hi = 0, all = 0;
  for (let i = 0; i < FRAME; i++) {
    const v = sig[off + i];
    const l = lowPass70[off + i];
    const m = lowPass1k[off + i];
    lo += l * l;
    mid += (m - l) * (m - l);
    hi += (v - m) * (v - m);
    all += v * v;
  }
  band.low[f] = Math.log(1e-12 + lo / FRAME);
  band.mid[f] = Math.log(1e-12 + mid / FRAME);
  band.high[f] = Math.log(1e-12 + hi / FRAME);
  band.all[f] = Math.log(1e-12 + all / FRAME);
}

// 起音强度（半波整流差分）+ 稳健归一化
const flux = (env) => {
  const o = new Float64Array(frames);
  for (let f = 1; f < frames; f++) { const d = env[f] - env[f - 1]; o[f] = d > 0 ? d : 0; }
  const s = Float64Array.from(o).sort();
  const p50 = s[frames >> 1], p97 = s[Math.floor(frames * 0.97)] || 1;
  const span = (p97 - p50) || 1;
  return Float64Array.from(o, v => Math.max(0, Math.min(4, (v - p50) / span)));
};
const F = { low: flux(band.low), mid: flux(band.mid), high: flux(band.high), all: flux(band.all) };
// 打击乐综合强度：底鼓权重最高（卡点靠它）
const mix = new Float64Array(frames);
for (let f = 0; f < frames; f++) mix[f] = 0.60 * F.low[f] + 0.25 * F.mid[f] + 0.15 * F.high[f];

const sample = (arr, t) => {
  const x = t * FPS;
  const i = Math.floor(x);
  if (i < 0 || i >= frames - 1) return 0;
  const u = x - i;
  return arr[i] * (1 - u) + arr[i + 1] * u;
};

// ---------------------------------------------------------------- ① 自相关找 tempo
const bpmLo = 55, bpmHi = 200;
const lagLo = Math.floor(FPS * 60 / bpmHi);
const lagHi = Math.ceil(FPS * 60 / bpmLo);
const ac = [];
let mean = 0;
for (let f = 0; f < frames; f++) mean += mix[f];
mean /= frames;
for (let lag = lagLo; lag <= lagHi; lag++) {
  let s = 0, n = 0;
  for (let f = 0; f + lag < frames; f++) { s += (mix[f] - mean) * (mix[f + lag] - mean); n++; }
  ac.push({ lag, bpm: 60 * FPS / lag, v: s / n });
}
// 取局部峰（自相关常常在倍频处同样高，后面用相位得分裁决）
const peaksAC = ac.filter((p, i) => i > 0 && i < ac.length - 1 && p.v >= ac[i - 1].v && p.v >= ac[i + 1].v)
  .sort((a, b) => b.v - a.v).slice(0, 8);

// ---------------------------------------------------------------- ② 相位搜索
// 给定 period(秒)，扫相位，得分 = 网格点上 mix 的平均（减去网格间平均作为对比度）
function fitGrid(period) {
  const N = Math.floor(dur / period);
  let best = { score: -1e9, phase: 0, contrast: 0 };
  const steps = 200;
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * period;
    let on = 0, cnt = 0;
    for (let k = 0; k * period + phase < dur - period * 0.5; k++) {
      on += sample(mix, phase + k * period); cnt++;
    }
    if (!cnt) continue;
    const avgOn = on / cnt;
    // 网格之间的中点作为对照（半拍位置）→ 对比度，越高说明网格越"咬"在击打上
    let off = 0, cnt2 = 0;
    for (let k = 0; k * period + phase + period / 2 < dur - period * 0.5; k++) {
      off += sample(mix, phase + k * period + period / 2); cnt2++;
    }
    const avgOff = cnt2 ? off / cnt2 : 0;
    const score = avgOn;
    if (score > best.score) best = { score: avgOn, phase, contrast: avgOn - avgOff, offAvg: avgOff };
  }
  best.period = period;
  best.bpm = 60 / period;
  best.beats = Math.floor((dur - best.phase) / period);
  return best;
}

const candidates = [];
const seenBpm = new Set();
const addCandidate = (bpm) => {
  if (bpm < bpmLo || bpm > bpmHi) return;
  const key = Math.round(bpm * 2) / 2;
  if (seenBpm.has(key)) return;
  seenBpm.add(key);
  candidates.push(fitGrid(60 / bpm));
};
peaksAC.forEach(p => addCandidate(p.bpm));
// 倍频 / 半频也纳入比较（自相关的经典歧义）
peaksAC.slice(0, 4).forEach(p => { addCandidate(p.bpm * 2); addCandidate(p.bpm / 2); });
[96, 120, 128, 100, 90, 110].forEach(addCandidate); // 常见值兜底

candidates.sort((a, b) => b.score - a.score);
const best = candidates[0];

// ---------------------------------------------------------------- ③ 量 beats.json
let beats = null;
try { beats = JSON.parse(await readFile(BEATS, 'utf8')); } catch { /* 无 */ }

const gridDev = (list, period, phase) => {
  const devs = list.map(t => {
    const k = Math.round((t - phase) / period);
    return (t - (phase + k * period)) * 1000; // ms
  });
  const abs = devs.map(Math.abs).sort((a, b) => a - b);
  return {
    n: list.length,
    medianAbs: +abs[abs.length >> 1]?.toFixed(1),
    p90Abs: +abs[Math.floor(abs.length * 0.9)]?.toFixed(1),
    maxAbs: +abs[abs.length - 1]?.toFixed(1),
    inTolerance: +(100 * abs.filter(v => v <= 40).length / Math.max(1, abs.length)).toFixed(1),
  };
};

// 每个 onset 的频段构成：判断它到底是底鼓还是镲/人声
const profile = (list) => {
  const rows = list.map(t => {
    // 在 ±40ms 内取各频段起音强度的峰值
    const w = [];
    for (let d = -0.04; d <= 0.0401; d += 0.005) w.push(t + d);
    const pk = (arr) => Math.max(...w.map(x => sample(arr, x)));
    const lo = pk(F.low), md = pk(F.mid), hi = pk(F.high);
    const tot = lo + md + hi || 1;
    return { t, low: lo / tot, mid: md / tot, high: hi / tot, strength: Math.max(lo, md, hi) };
  });
  const avg = k => +(100 * rows.reduce((a, r) => a + r[k], 0) / rows.length).toFixed(1);
  return { rows, lowPct: avg('low'), midPct: avg('mid'), highPct: avg('high') };
};

// 网格漏拍 / 双触发检查
function gridCoverage(list, period, phase) {
  const total = Math.floor((dur - phase) / period);
  const hit = new Set();
  list.forEach(t => hit.add(Math.round((t - phase) / period)));
  const covered = [...hit].filter(k => k >= 0 && k < total).length;
  return { totalBeats: total, covered, coveragePct: +(100 * covered / total).toFixed(1) };
}

const out = {
  audio: path.basename(AUDIO), duration: +dur.toFixed(2),
  fitted: {
    bpm: +best.bpm.toFixed(2),
    period: +best.period.toFixed(4),
    phase: +best.phase.toFixed(3),
    gridPoints: best.beats,
    onsetScoreOnGrid: +best.score.toFixed(3),
    onsetScoreHalfBeat: +(best.offAvg ?? 0).toFixed(3),
    contrast: +best.contrast.toFixed(3),
  },
  topCandidates: candidates.slice(0, 6).map(c => ({
    bpm: +c.bpm.toFixed(1), onGrid: +c.score.toFixed(3), halfBeat: +(c.offAvg ?? 0).toFixed(3), contrast: +c.contrast.toFixed(3),
  })),
  acPeaks: peaksAC.map(p => ({ bpm: +p.bpm.toFixed(1), ac: +p.v.toFixed(4) })),
};

if (beats) {
  const period = best.period, phase = best.phase;
  const pOn = profile(beats.onsets);
  const pSt = profile(beats.strong);
  out.beatsJson = {
    bpm: beats.bpm, onsets: beats.onsets.length, strong: beats.strong.length,
    onsetsVsFittedGrid: gridDev(beats.onsets, period, phase),
    strongVsFittedGrid: gridDev(beats.strong, period, phase),
    onsetsVsOwnBpmGrid: gridDev(beats.onsets, 60 / beats.bpm, 0),
    strongProfile: { lowPct: pSt.lowPct, midPct: pSt.midPct, highPct: pSt.highPct },
    onsetsProfile: { lowPct: pOn.lowPct, midPct: pOn.midPct, highPct: pOn.highPct },
    coverage: gridCoverage(beats.onsets, period, phase),
    // 直接用 beats.strong 当网格点的平均强度（高 = 真的落在击打上）
    strongAsGridScore: +(beats.strong.reduce((a, t) => a + sample(mix, t), 0) / beats.strong.length).toFixed(3),
    // 随机时刻的平均强度，作为对照基线
    randomScore: +(Array.from({ length: beats.strong.length }, (_, i) => sample(mix, (i + 0.5) * dur / beats.strong.length)).reduce((a, b) => a + b, 0) / beats.strong.length).toFixed(3),
    // 每 8 拍的间隔，看是否漂移
    strongGapsMs: beats.strong.slice(1, 17).map((t, i) => +((t - beats.strong[i]) * 1000).toFixed(0)),
  };
}

// ---------------------------------------------------------------- ④ 这首歌到底有没有鼓
// 低频包络的周期性（自相关峰值 / 零滞后）：底鼓若稳定存在，这个值会明显偏高
function lowRhythm(f0 = 0, f1 = frames) {
  const env = band.low;
  const n = f1 - f0;
  if (n < 200) return null;
  let m = 0; for (let f = f0; f < f1; f++) m += env[f]; m /= n;
  let z = 0; for (let f = f0; f < f1; f++) z += (env[f] - m) ** 2; z /= n;
  if (!z) return null;
  let best = { lag: 0, r: -1 };
  for (let lag = Math.round(FPS * 0.30); lag <= Math.round(FPS * 1.20); lag++) {
    let s = 0, c = 0;
    for (let f = f0; f + lag < f1; f++) { s += (env[f] - m) * (env[f + lag] - m); c++; }
    const r = c ? (s / c) / z : -1;
    if (r > best.r) best = { lag, r };
  }
  return { r: +best.r.toFixed(3), bpm: +(60 * FPS / best.lag).toFixed(1) };
}

const segments = [];
const SEG = 20;
for (let t0 = 0; t0 < dur; t0 += SEG) {
  const f0 = Math.floor(t0 * FPS), f1 = Math.min(frames, Math.floor((t0 + SEG) * FPS));
  if (f1 - f0 < 300) continue;
  let eAll = 0, eLow = 0;
  for (let f = f0; f < f1; f++) { eAll += Math.exp(band.all[f]); eLow += Math.exp(band.low[f]); }
  const lr = lowRhythm(f0, f1);
  segments.push({
    from: t0, to: +(t0 + SEG).toFixed(0),
    rmsDb: +(10 * Math.log10(eAll / (f1 - f0))).toFixed(1),
    lowPct: +(100 * eLow / eAll).toFixed(1),
    lowRhythmR: lr?.r, lowRhythmBpm: lr?.bpm,
  });
}

out.kickEvidence = {
  wholeTrackLowRhythm: lowRhythm(),
  segments,
  note: 'lowRhythmR < 0.25 基本等于"低频没有稳定律动"（即听不到底鼓循环）',
};

console.log(JSON.stringify(out, null, 2));
