#!/usr/bin/env node
/**
 * run.mjs — 一条命令跑完整条流水线（校验 → 体检 → 渲染 → 终检）
 *
 * 为什么要有这个：每一步单独调用都要一次工具往返 + 一段输出。
 * 合成一条命令后，模型只读一段汇总，token 消耗降到 1/4。
 *
 * 用法：
 *   node run.mjs --story story.json --out out/final.mp4
 *   node run.mjs --story story.json --out out/final.mp4 --bgm bgm.mp3
 *   node run.mjs --story story.json --out out/final.mp4 --draft   # 1fps 快速试片
 *   node run.mjs --story story.json --sheet out/sheet.png          # 附带联系图
 *   node run.mjs --story story.json --aspect wide                  # 横屏 1920×1080
 *
 * 任一步失败即停，并保留那一步的原始输出（那才是可执行的信息）。
 * 退出码：0 成功 / 非 0 失败
 */

import { spawnSync } from 'node:child_process';
import { statSync, existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const script = (f) => path.join(HERE, f);

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (k) => argv.includes('--' + k);

const STORY = path.resolve(arg('story', 'story.json'));
const OUT = path.resolve(arg('out', 'out/final.mp4'));
const HTML = path.resolve(arg('html', path.join(path.dirname(OUT), 'story.html')));
const SHEET = arg('sheet') ? path.resolve(arg('sheet')) : null;
const BGM_RAW = arg('bgm');
const BGM_OFF = ['none', 'off', 'false'].includes(BGM_RAW);
const BGM = BGM_RAW && !BGM_OFF ? path.resolve(BGM_RAW) : null; // 不传则用 assets/bgm 自带神曲
const DRAFT = has('draft');
const CRF = arg('crf');
const WORKERS = arg('workers');
const FORMAT = arg('format');
const QUALITY = arg('quality');
// 画幅：portrait（默认 1080×1920）/ wide（1920×1080）。build 选模板，render 定视口，必须一起传
const ASPECT = arg('aspect');
const ASPECT_ARGS = ASPECT ? ['--aspect', ASPECT] : [];

if (!existsSync(STORY)) {
  console.error(`[run] 找不到 ${STORY}`);
  process.exit(1);
}
await mkdir(path.dirname(OUT), { recursive: true });

const t0 = Date.now();
const mark = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

function step(label, file, args) {
  process.stderr.write(`\n▸ ${label}\n`);
  const r = spawnSync(process.execPath, [script(file), ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n✗ ${label} 未通过（退出码 ${r.status}）。按上面的 → 提示改 story.json，然后重跑本命令。`);
    process.exit(r.status || 1);
  }
}

// ① 容量校验 + 注入
step('① 校验与注入', 'build.mjs', ['--story', STORY, '--out', HTML, ...(has('no-beat') ? ['--no-beat'] : []), ...ASPECT_ARGS]);

// ② 排版体检（负数/零错才继续）
step('② 排版体检', 'qa.mjs', ['--html', HTML, ...(SHEET ? ['--sheet', SHEET] : [])]);

// ③ 渲染
const rArgs = ['--html', HTML, '--out', OUT, '--quiet', ...ASPECT_ARGS];
if (BGM) rArgs.push('--bgm', BGM);
else if (BGM_OFF) rArgs.push('--bgm', 'none');
if (CRF) rArgs.push('--crf', CRF);
if (WORKERS) rArgs.push('--workers', WORKERS);
if (FORMAT) rArgs.push('--format', FORMAT);
if (QUALITY) rArgs.push('--quality', QUALITY);
if (DRAFT) rArgs.push('--step', '15');
process.stderr.write(`\n▸ ③ 渲染（${DRAFT ? '1/15 抽帧试片' : '全帧 · 并行'}，约 ${DRAFT ? '20 秒' : '1–2 分钟'}）\n`);
const r = spawnSync(process.execPath, [script('render.mjs'), ...rArgs], { encoding: 'utf8' });
if (r.status !== 0) {
  console.error(`\n✗ 渲染失败：\n${(r.stderr || '').slice(-1200)}`);
  process.exit(r.status || 1);
}
let info = {};
try { info = JSON.parse((r.stdout || '').match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch {}

// ④ 成片终检（黑屏）——只测视频，不重跑几何体检
step('④ 成片终检', 'qa.mjs', ['--html', HTML, '--video', OUT, '--video-only']);

const mb = (() => { try { return +(statSync(OUT).size / 1048576).toFixed(1); } catch { return '?'; } })();
const secs = (() => {
  try {
    const s = JSON.parse(readFileSync(STORY, 'utf8'));
    return s.scenes.reduce((a, x) => a + (Number(x.dur) || 0), 0);
  } catch { return '?'; }
})();

console.log(`\n✓ 完成 ${secs}s · ${info.frames || '?'} 帧 · ${mb}MB · 音轨 ${info.bgm || '?'}`
  + ` · ${info.workers || '?'} 并发 · ${info.msPerFrame || '?'}ms/帧 · 用时 ${mark()}`);
console.log(`  ${OUT}${SHEET ? `\n  联系图 ${SHEET}` : ''}`);
// 自进化协议的触发器：每次都出现，避免「想起来才沉淀」
console.log('  ▸ 有新事实？selfcheck.mjs → learn.mjs add → push.js "learn: …"（SKILL.md §9）');
