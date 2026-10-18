#!/usr/bin/env node
/**
 * build.mjs — story.json → story.html（内容注入 + 容量校验）
 *
 * 这一步是「容量估算」的代码化：把竖屏单屏能承载的字数写成硬约束，
 * 在渲染之前就把「必然溢出」的文案拦下来，而不是等出片后眼睛发现。
 *
 * 用法：
 *   node build.mjs --story story.json --out out/story.html
 *   node build.mjs --story story.json --out out/story.html --strict   # 警告也当错误
 *
 * 退出码：0 通过（可能有警告）/ 1 有错误
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TEMPLATE = path.join(ROOT, 'assets', 'template.html');
const FONT_DIR = path.join(ROOT, 'assets', 'fonts');

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const STRICT = argv.includes('--strict');
const NO_BEAT = argv.includes('--no-beat');   // 关闭卡点，用原始时长
const BEATS_FILE = arg('beats', null);        // 指定击打点表，默认 assets/beats.json
const STORY_PATH = path.resolve(arg('story', 'story.json'));
const OUT = path.resolve(arg('out', 'out/story.html'));
const QUIET = argv.includes('--quiet');

if (!existsSync(STORY_PATH)) {
  console.error(`[build] 错误：找不到 story.json：${STORY_PATH}`);
  process.exit(1);
}
if (!existsSync(TEMPLATE)) {
  console.error(`[build] 错误：找不到模板：${TEMPLATE}`);
  process.exit(1);
}

// ---------------------------------------------------------------- 容量预算
/** 竖屏 1080 宽、左右各 96 安全边 → 内容宽 888px。字号下限决定单行可容纳的字数 */
const BUDGET = {
  // avail: 可用宽度  |  base/min: 自动降字号区间  |  fixed: 不自动缩放的固定字号
  title:  { lines: 2, avail: 888, base: 128, min: 56, floor: 60 },
  quote:  { lines: 3, avail: 880, base: 76,  min: 42, floor: 52 },
  body:   { lines: 2, avail: 820, fixed: 40, floor: 34 },
  label:  { lines: 2, avail: 720, fixed: 36, floor: 30 },
  kicker: { lines: 1, avail: 888, fixed: 25, track: 0.28 },
  cite:   { lines: 1, avail: 888, fixed: 23, track: 0.16 },
};
const DUR = { min: 4, max: 9, totalMin: 35, totalMax: 80 };
const TYPES = ['hook', 'quote', 'scene', 'stat', 'outro'];
const FX = ['particles', 'grid', 'curve', 'flow', 'bars'];

// ---------------------------------------------------------------- 文本工具
const stripTags = (s) => String(s ?? '').replace(/<[^>]+>/g, '');
const toLines = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : []);

/** 单字宽度折算（em 为单位）：中文全角 1，拉丁 0.55，空格 0.3 */
const emOf = (ch) => {
  if (ch === ' ') return 0.30;
  const c = ch.codePointAt(0);
  return c < 0x2E80 ? 0.55 : 1.0;
};
const emWidth = (s) => [...stripTags(s).replace(/\n/g, '')].reduce((a, ch) => a + emOf(ch), 0);
const charCount = (s) => [...stripTags(s).replace(/\s/g, '')].length;

/** 按模板真实排版规则估算字号 / 行宽，用于在写文案阶段就预判溢出 */
function estMetry(kind, text) {
  const b = BUDGET[kind];
  const em = emWidth(text);
  const cnt = charCount(text);
  if (b.fixed) {
    const w = (em + (b.track || 0) * cnt) * b.fixed;
    return { px: b.fixed, width: w, avail: b.avail, fit: w <= b.avail };
  }
  const px = Math.max(b.min, Math.min(b.base, Math.floor(b.avail / (Math.max(1, em) * 1.04))));
  return { px, width: em * px, avail: b.avail, fit: px >= b.floor };
}

// ---------------------------------------------------------------- 校验
const errors = [];
const warns = [];
const err = (where, msg, fix) => errors.push({ where, msg, fix });
const warn = (where, msg, fix) => warns.push({ where, msg, fix });

function checkBlock(where, kind, value) {
  if (value === undefined || value === null || value === '') return;
  const b = BUDGET[kind];
  const lines = toLines(value);
  if (lines.length > b.lines) {
    err(where, `${kind} 有 ${lines.length} 行，超过 ${b.lines} 行`,
      `拆成两个场景，或压到 ${b.lines} 行以内`);
  }
  lines.forEach((ln, i) => {
    const m = estMetry(kind, ln);
    const at = `${where}.${kind}[第${i + 1}行]`;
    if (m.fixed) {
      if (!m.fit) err(at, `估宽 ${m.width.toFixed(0)}px > 可用 ${m.avail}px（会越过安全区）`,
        `删掉约 ${Math.ceil((m.width - m.avail) / m.px)} 个字`);
      else if (m.width > m.avail * 0.94) warn(at, `估宽 ${m.width.toFixed(0)}px 贴近 ${m.avail}px`, '再删 1–2 字更透气');
    } else {
      if (!m.fit) err(at, `需要压到 ${m.px}px 才放得下（可读下限 ${b.floor}px）`,
        `删约 ${Math.ceil(emWidth(ln) - b.avail / (b.floor * 1.04))} 个字`);
      else if (m.px < b.floor * 1.12) warn(at, `字号约 ${m.px}px，偏小`, '再删 1–2 字会更有气势');
    }
  });
}

function validate(story) {
  if (!story || typeof story !== 'object') return err('root', 'story 不是对象', '检查 JSON 语法');
  const scenes = story.scenes;
  if (!Array.isArray(scenes) || scenes.length < 3) {
    return err('scenes', '场景数不足 3 个', '一条 40–60s 的视频通常 6–8 个场景');
  }
  if (scenes.length > 12) err('scenes', `场景 ${scenes.length} 个，超过 12`, '合并同类信息，竖屏注意力撑不住');

  const meta = story.meta || {};
  story.meta = meta;
  meta.series = meta.series ?? '';
  meta.handle = meta.handle ?? '@你的账号';
  meta.startIndex = Number(meta.startIndex ?? 1);
  if (charCount(meta.series) > 20) warn('meta.series', '系列名超过 20 字符，左上角可能挤压', '缩到 20 以内');
  if (charCount(meta.handle) > 16) warn('meta.handle', '账号名超过 16 字符，左上角可能溢出', '缩到 16 以内');


  let total = 0;
  scenes.forEach((sc, i) => {
    const w = `scenes[${i}]`;
    if (!TYPES.includes(sc.type)) {
      err(`${w}.type`, `未知类型 "${sc.type}"`, `可选用：${TYPES.join(' / ')}`);
      return;
    }
    const dur = Number(sc.dur);
    if (Number.isFinite(dur)) total += dur;
    if (!Number.isFinite(dur) || dur < DUR.min || dur > DUR.max) {
      err(`${w}.dur`, `时长 ${sc.dur}s 超出 ${DUR.min}–${DUR.max}s`,
        '按朗读速度 5–6 字/秒估算，超过 9s 观众会划走');
    }

    checkBlock(w, 'kicker', sc.kicker);
    checkBlock(w, 'cite', sc.cite);

    if (sc.type === 'quote') {
      if (!sc.quote) err(`${w}.quote`, 'quote 场景缺 quote 字段', '写上要引用的那一句');
      else checkBlock(w, 'quote', sc.quote);
    } else if (sc.type === 'stat') {
      if (!sc.stat || typeof sc.stat !== 'object') {
        err(`${w}.stat`, 'stat 场景缺 stat 对象', '{ from:0, to:3, decimals:0, unit:"BITS" }');
      } else {
        if (!Number.isFinite(Number(sc.stat.to))) err(`${w}.stat.to`, 'stat.to 必须是数字', '例如 3');
        if (!sc.label) warn(`${w}.label`, 'stat 场景没有 label，画面只有数字会很空', '补一句解释');
      }
      checkBlock(w, 'label', sc.label);
    } else {
      if (!sc.title) err(`${w}.title`, `${sc.type} 场景缺 title`, '标题是这一屏的主张，必须有');
      else checkBlock(w, 'title', sc.title);
      checkBlock(w, 'body', sc.body);
    }

    if (sc.fx) {
      if (!FX.includes(sc.fx.type)) {
        err(`${w}.fx.type`, `未知图形 "${sc.fx.type}"`, `可选用：${FX.join(' / ')}`);
      }
      if (['grid', 'curve', 'flow', 'bars'].includes(sc.fx.type) && sc.type === 'stat') {
        warn(`${w}.fx`, 'stat 场景同时有图形，画面会过载', 'stat 靠数字本身，去掉 fx');
      }
    }
    // 有图形 + 长正文 = 下半区被占，正文容易压线
    if (sc.fx && ['grid', 'curve', 'flow', 'bars'].includes(sc.fx.type)) {
      const bodyLines = toLines(sc.body).length;
      if (bodyLines > 2) err(`${w}.body`, '带图形的场景正文超过 2 行', '图形占了下半区，正文只能给 2 行');
    }
  });

  if (total < DUR.totalMin) warn('scenes', `总时长 ${total}s < ${DUR.totalMin}s`, '抖音知识类完播友好区间 40–70s');
  if (total > DUR.totalMax) err('scenes', `总时长 ${total}s > ${DUR.totalMax}s`, '砍场景，不要砍单场景时长');

  // 节奏检查：开场钩子必须短
  if (scenes[0] && scenes[0].type !== 'hook') warn('scenes[0]', '开场不是 hook', '前 3 秒决定划走率，第一屏必须是钩子');
  if (scenes[0] && Number(scenes[0].dur) > 6) warn('scenes[0].dur', '开场超过 6s', '钩子要快，4–5s 足够');

  return null;
}

// ---------------------------------------------------------------- 卡点
/**
 * 把每个分屏的切换点推到最近的音乐击打上。
 * 只在 ±0.5s 内移动：太远会破坏叙事节奏，"卡点"也听不出来。
 * 返回每个场景的实际时长（原地修改 story）。
 */
function snapToOnsets(scenes, beats) {
  if (!beats || !Array.isArray(beats.onsets) || !beats.onsets.length) return null;

  const onsets = beats.onsets;
  const strong = (beats.strong || []).slice();
  const WINDOW = 0.5;      // 允许的最大位移
  const pick = (want, lo, hi) => {
    const near = (pool) => pool
      .filter(p => p >= lo && p <= hi && Math.abs(p - want) <= WINDOW)
      .sort((x, y) => Math.abs(x - want) - Math.abs(y - want))[0];
    // 优先落在重拍（底鼓）上，找不到再退到普通击打
    const s = near(strong), o = s == null ? near(onsets) : null;
    const t = s ?? o;
    return { t: t ?? want, onBeat: t != null };
  };

  let t = 0, moved = 0, aligned = 0, maxShift = 0;
  const ideal = scenes.map(s => Number(s.dur) || 6);
  for (let i = 0; i < scenes.length - 1; i++) {
    const want = t + ideal[i];
    const { t: hit, onBeat } = pick(want, t + DUR.min, t + DUR.max);
    if (onBeat) aligned++;
    const shift = Math.abs(hit - want);
    if (shift > 0.02) moved++;
    maxShift = Math.max(maxShift, shift);
    scenes[i].dur = +(hit - t).toFixed(2);
    t = hit;
  }
  scenes[scenes.length - 1].dur = +Math.max(DUR.min,
    Math.min(DUR.max, ideal[scenes.length - 1])).toFixed(2);

  return { bpm: beats.bpm, aligned, cuts: scenes.length - 1, moved, maxShift: +maxShift.toFixed(2), onsets: onsets.length };
}

// ---------------------------------------------------------------- 注入
function inject(template, story, beats) {
  const json = JSON.stringify(story, null, 2).replace(/</g, '\\u003c');
  // 节拍层数据：只注入片长范围内的击打点，控制体积
  const beatScript = beats
    ? `<script>window.__BEATS__ = ${JSON.stringify(beats).replace(/</g, '\\u003c')};</script>\n`
    : '';
  const injectScript = beatScript + `<script>window.__STORY__ = ${json};</script>\n`;

  // 字体路径改成绝对 file:// —— 保证 html 输出到任意目录都能找到 fonts/
  let html = template.replace(/url\("fonts\/([^"]+)"\)/g, (_m, f) => {
    const abs = path.join(FONT_DIR, f);
    return `url("${pathToFileURL(abs).href}")`;
  });

  const anchor = '<script>\n/* ============================================================\n   ② 内容层';
  if (!html.includes(anchor)) throw new Error('模板结构变了：找不到内容层锚点，无法注入');
  return html.replace(anchor, injectScript + anchor);
}

// ---------------------------------------------------------------- main
const raw = await readFile(STORY_PATH, 'utf8');
let story;
try {
  story = JSON.parse(raw);
} catch (e) {
  console.error(`[build] story.json 解析失败：${e.message}`);
  process.exit(1);
}

validate(story);

if (!QUIET) {
  const scenes = story.scenes || [];
  const total = scenes.reduce((a, s) => a + (Number(s.dur) || 0), 0);
  console.error(`[build] 场景 ${scenes.length} 个 · 总时长 ${total}s · 平均 ${(total / Math.max(1, scenes.length)).toFixed(1)}s/屏`);
  scenes.forEach((s, i) => {
    const kind = s.type === 'quote' ? 'quote' : s.type === 'stat' ? 'label' : 'title';
    const lines = toLines(s[kind]);
    const px = lines.length ? Math.min(...lines.map(l => estMetry(kind, l).px)) : 0;
    const tag = s.type.padEnd(5);
    console.error(`  ${String(i + 1).padStart(2)}. ${tag} ${String(s.dur).padStart(4)}s  ${kind} ${String(px).padStart(3)}px`);
  });
  warns.forEach(w => console.error(`  [警告] ${w.where}：${w.msg}\n          → ${w.fix}`));
  errors.forEach(e => console.error(`  [错误] ${e.where}：${e.msg}\n          → ${e.fix}`));
}

if (errors.length || (STRICT && warns.length)) {
  console.error(`[build] 未通过：${errors.length} 个错误，${warns.length} 个警告。先改 story.json，不要渲。`);
  process.exit(1);
}

const template = await readFile(TEMPLATE, 'utf8');

// 卡点：把切屏推到音乐击打上（默认开启，--no-beat 关闭）
let beatInfo = null;
let beatData = null;
if (!NO_BEAT) {
  try {
    const bp = BEATS_FILE ? path.resolve(BEATS_FILE) : path.join(ROOT, 'assets', 'beats.json');
    beatData = JSON.parse(await readFile(bp, 'utf8'));

    // 指纹对不上就别默默沿用旧卡点：换了 mp3 必须重跑 beat.mjs
    if (beatData.audioMd5 && beatData.audio) {
      const audioPath = path.join(ROOT, 'assets', 'bgm', beatData.audio);
      if (existsSync(audioPath)) {
        const md5 = createHash('md5').update(await readFile(audioPath)).digest('hex');
        if (md5 !== beatData.audioMd5) {
          console.error(`[build] 警告：${beatData.audio} 已变，但卡点表还是旧的指纹。重跑 scripts/beat.mjs 或加 --no-beat`);
        }
      }
    }

    beatInfo = snapToOnsets(story.scenes, beatData);
    if (beatInfo && !QUIET) {
      const { aligned, cuts, moved, maxShift } = beatInfo;
      console.error(`[build] 卡点：BPM ${beatInfo.bpm} · ${aligned}/${cuts} 个切点落在击打上`
        + `（${moved} 处微调，最大位移 ${maxShift}s）`);
      if (aligned < cuts) {
        console.error(`[build] 警告：有 ${cuts - aligned} 个切点 ±0.5s 内找不到击打，只能硬切。`
          + `把该屏 dur 调成 4.25 / 2.83 这类 8.5s 的整数分之一`);
      }
    }
  } catch (e) {
    if (!QUIET) console.error(`[build] 跳过卡点：${e.message}（跑 scripts/beat.mjs 生成 assets/beats.json）`);
  }
}

// 节拍可视化层：注入片长内的击打点，模板据此每拍画冲击波 / 拍格 / 画面 punch
let beatsForVisual = null;
if (beatData && Array.isArray(beatData.onsets) && beatData.onsets.length) {
  const total = story.scenes.reduce((a, s) => a + (Number(s.dur) || 0), 0);
  const inRange = (t) => t <= total + 0.05;
  beatsForVisual = {
    bpm: beatData.bpm,
    period: +(beatData.period || 60 / beatData.bpm).toFixed(5),
    loopBeats: Number(beatData.strongEvery) > 1 ? Math.min(64, Number(beatData.strongEvery)) : 16,
    onsets: beatData.onsets.filter(inRange),
    strong: (beatData.strong || []).filter(inRange),
  };
  if (!QUIET) console.error(`[build] 节拍层：${beatsForVisual.onsets.length} 个击打点（片长 ${total.toFixed(2)}s）`);
}

const html = inject(template, story, beatsForVisual);
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, html, 'utf8');

console.log(JSON.stringify({
  ok: true,
  html: OUT,
  scenes: story.scenes.length,
  duration: +story.scenes.reduce((a, s) => a + (Number(s.dur) || 0), 0).toFixed(2),
  beat: beatInfo,
  beatVisual: beatsForVisual ? beatsForVisual.onsets.length : 0,
  warnings: warns,
}, null, 2));
