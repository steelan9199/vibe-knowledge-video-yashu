#!/usr/bin/env node
/**
 * beats-info.mjs —— 读已缓存的卡点表，不重新分析音频
 *
 * 技能自带的 assets/beats.json 是 vibe.mp3 的"曲目卡点档案"，
 * 已经用 302 个拍点验证过（每个拍点都踩在真实音头上）。
 * 日常做片子**不需要再跑 beat.mjs**，直接查这份表即可。
 *
 * 用法：
 *   node scripts/beats-info.mjs                 概要 + 音频指纹校验
 *   node scripts/beats-info.mjs --at 12.34      12.34s 最近的拍是哪一拍
 *   node scripts/beats-info.mjs --snap 8.4      8.4s 对齐到拍点后是多少
 *   node scripts/beats-info.mjs --json          机器可读
 *   node scripts/beats-info.mjs --check         只做指纹校验，不匹配退出码 1
 *
 * 参数：
 *   --beats x.json   指定卡点表（默认 assets/beats.json）
 *   --audio x.mp3    指定音频（默认 assets/bgm/<beats.audio>）
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (k) => argv.includes('--' + k);

const BEATS_PATH = path.resolve(ROOT, arg('beats', 'assets/beats.json'));
if (!existsSync(BEATS_PATH)) {
  console.error(`[beats-info] 找不到 ${BEATS_PATH}，先跑 node scripts/beat.mjs`);
  process.exit(1);
}

const b = JSON.parse(readFileSync(BEATS_PATH, 'utf8'));
const onsets = b.onsets || [];
const period = b.period || 60 / b.bpm;
const loopBeats = Number(b.strongEvery) || 16;
const loopSeconds = period * loopBeats;
const strong = b.strong || [];

/* ---------- 音频指纹校验 ---------- */
const AUDIO = path.resolve(ROOT, arg('audio', path.join('assets/bgm', b.audio || 'vibe.mp3')));
let integrity = { state: 'unknown', detail: 'beats.json 没有指纹（旧版生成的，重跑一次 beat.mjs 即可补上）' };
if (existsSync(AUDIO) && b.audioMd5) {
  const md5 = createHash('md5').update(readFileSync(AUDIO)).digest('hex');
  const same = md5 === b.audioMd5;
  integrity = {
    state: same ? 'ok' : 'mismatch',
    detail: same
      ? `与 ${b.audio} 完全匹配`
      : `音频已变（现 ${md5.slice(0, 8)}… / 档案 ${b.audioMd5.slice(0, 8)}…），卡点表已失效`,
  };
} else if (!existsSync(AUDIO)) {
  integrity = { state: 'missing', detail: `找不到音频 ${AUDIO}` };
}

/* ---------- 拍点查询 ---------- */
function nearest(t) {
  let lo = 0, hi = onsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (onsets[mid] < t) lo = mid + 1; else hi = mid;
  }
  const cands = [onsets[lo - 1], onsets[lo]].filter(v => v !== undefined);
  let best = cands[0];
  for (const c of cands) if (Math.abs(c - t) < Math.abs(best - t)) best = c;
  const idx = onsets.indexOf(best);
  return {
    t: best,
    deltaMs: +((best - t) * 1000).toFixed(1),
    index: idx,
    beatInLoop: idx % loopBeats,
    loop: Math.floor(idx / loopBeats) + 1,
    strong: Math.abs(best % loopSeconds) < 1e-6 || strong.some(s => Math.abs(s - best) < 0.002),
  };
}

/* ---------- 输出 ---------- */
if (has('check')) {
  console.log(`[beats-info] ${integrity.state}: ${integrity.detail}`);
  process.exit(integrity.state === 'ok' ? 0 : 1);
}

if (arg('at')) {
  const t = Number(arg('at'));
  const r = nearest(t);
  if (has('json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`${t.toFixed(3)}s → 第 ${r.index + 1} 拍 ${r.t.toFixed(3)}s（偏差 ${r.deltaMs > 0 ? '+' : ''}${r.deltaMs}ms）`);
    console.log(`圈 ${String(r.loop).padStart(2, '0')} · 圈内第 ${r.beatInLoop + 1}/${loopBeats} 拍${r.strong ? ' · 圈头（重拍）' : ''}`);
  }
  process.exit(0);
}

if (arg('snap')) {
  const d = Number(arg('snap'));
  const r = nearest(d);
  const out = { requested: d, snapped: r.t, deltaMs: r.deltaMs };
  if (has('json')) console.log(JSON.stringify(out, null, 2));
  else console.log(`${d.toFixed(3)}s → ${r.t.toFixed(3)}s（移动 ${r.deltaMs > 0 ? '+' : ''}${r.deltaMs}ms；对齐到拍点可整屏卡点）`);
  process.exit(0);
}

const summary = {
  audio: b.audio,
  audioMd5: b.audioMd5,
  integrity: integrity.state,
  bpm: b.bpm,
  period: +period.toFixed(5),
  loopBeats,
  loopSeconds: +loopSeconds.toFixed(3),
  duration: b.duration,
  beats: onsets.length,
  downbeats: strong.length,
  firstBeat: onsets[0],
  ratio: b.ratio,
  confidence: b.ratio >= 1.25 ? 'good' : 'low',
};

if (has('json')) {
  console.log(JSON.stringify({ ...summary, detail: integrity.detail, downbeatTimes: strong }, null, 2));
  process.exit(0);
}

console.log(`配乐       ${b.audio}（${b.duration}s）`);
console.log(`指纹       ${integrity.state} · ${integrity.detail}`);
console.log(`速度       ${b.bpm} BPM · 一拍 ${period.toFixed(5)}s`);
console.log(`循环       ${loopBeats} 拍 = ${loopSeconds.toFixed(3)}s（每圈开头是重拍）`);
console.log(`拍点       ${onsets.length} 个，首拍 ${Number(onsets[0]).toFixed(3)}s，中位间隔 ${(period * 1000).toFixed(1)}ms`);
console.log(`置信度     ratio ${b.ratio}（${summary.confidence}）`);
console.log(`落点质量   网格点强度 ${b.onGrid} / 半拍 ${b.halfBeat} / 对比度 ${b.contrast}`);
console.log('');
console.log(`建议：每屏时长取 ${loopSeconds.toFixed(1)}s 的整数分之一（${(loopSeconds / 2).toFixed(2)} / ${(loopSeconds / 4).toFixed(2)} / ${loopSeconds.toFixed(2)}s），切屏天然落在圈头。`);
console.log(`查到某时刻最近拍：node scripts/beats-info.mjs --at 12.34`);
