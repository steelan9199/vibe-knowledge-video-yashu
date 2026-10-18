#!/usr/bin/env node
/**
 * build.mjs — story.json → story.html（内容注入 + 容量校验）
 *
 * 这一步是「容量估算」的代码化：把竖屏单屏能承载的字数写成硬约束，
 * 在渲染之前就把「必然溢出」的文案拦下来，而不是等出片后眼睛发现。
 *
 * 用法：
 *   node build.mjs --story story.json --out out/story.html
 *   node build.mjs --story story.json --out out/story.html --aspect wide   # 横屏 1920×1080
 *   node build.mjs --story story.json --out out/story.html --strict        # 警告也当错误
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

/** 画幅：portrait（默认，1080×1920）/ wide（1920×1080）。
 *  两套模板的 DOM 与 story 字段完全不同，所以校验规则也分两套。 */
const ASPECT_RAW = String(arg('aspect', 'portrait')).toLowerCase();
const WIDE = ['wide', '16:9', 'landscape', 'horizontal'].includes(ASPECT_RAW);
if (!WIDE && !['portrait', '9:16', 'vertical', ''].includes(ASPECT_RAW)) {
  console.error(`[build] 未知画幅 "${ASPECT_RAW}"，可用：portrait（9:16） / wide（16:9）`);
  process.exit(1);
}
const TEMPLATE = path.join(ROOT, 'assets', WIDE ? 'template-wide.html' : 'template.html');

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

// ---------------------------------------------------------------- 横屏预算（1920×1080）
/**
 * 横屏不是「竖屏拉宽」：字号、字数、节奏全部另算。
 *  - 内容宽 = 1920 − 左 120 − 右 180（右侧抖音按钮区）= 1620px，但版心只有 840（左文）+ 图形盒
 *  - 标题 152px 时单行最多 8.6 个全角字，超过就要缩到 112px 以下，气势全失
 *  - 正文 42px 单行 20 字：横屏的阅读距离比竖屏近，但视线横扫宽度大，超过 20 字眼睛要「扫」两趟
 *  - 单屏 4.25s(8 拍) 或 8.5s(16 拍)，比竖屏长——横屏一屏信息量更大，切太快会读不完
 */
const WIDE_BUDGET = {
  titleEm: 8.6,        // 152px 标题单行上限（全角字宽）
  bodyEm: 20.5,        // 42px 正文单行上限
  kickerEm: 26,        // 34px 眉标
  titleLines: 2,
  bodyLines: 2,
  emLines: 1,          // <em> 高亮最多 1 处
  beatsMin: 4,         // 单屏至少 4 拍（2.13s）——再短横屏读不完
  beatsMax: 18,        // 单屏最多 18 拍（9.57s）
  totalMin: 50, totalMax: 70,
};

/** 枚举不在代码里写死，直接从模板解析：模板加了节点/版式，校验器自动跟上 */
function templateEnums(html) {
  const nodes = [...html.matchAll(/NODES\['([^']+)'\]\s*=/g)].map(m => m[1]);
  const layouts = [...new Set([...html.matchAll(/\.L-([a-z][a-z0-9-]*)\s/g)].map(m => m[1]))];
  return { nodes, layouts };
}

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

// ---------------------------------------------------------------- 元素级时间线
/** 两个画幅的 target 集合不同：模板里没有的元素，写了也不会报错，只会静默不生效 */
const ANIM_TARGETS = {
  portrait: ['kicker', 'title', 'chars', 'body', 'cite', 'label', 'num', 'unit', 'qmark', 'rule', 'stack'],
  wide:     ['kicker', 'kickerEn', 'title', 'body', 'node', 'foot', 'idx'],
};
const ANIM_FIELDS = ['target', 'delay', 'dur', 'stagger', 'dx', 'dy', 'blur', 's0', 'o0', 'ease'];
const ANIM_EASE = ['linear', 'out', 'in', 'inout', 'expo'];
const ANIM_LIMIT = {
  delay: [-2000, 6000], dur: [80, 2400], stagger: [0, 400],
  dx: [-400, 400], dy: [-400, 400], blur: [0, 60], s0: [0.5, 1.5], o0: [0, 1],
};

/**
 * anim 是「覆盖默认入场」的声明式时间线。这里只拦两类错：
 *  ① 字段/target 拼错 —— 模板对未知 target 是静默 return，不校验就会变成
 *     "写了 anim 但画面没变"这种翻遍日志也查不出的问题。
 *  ② 入场结束得太晚 —— 越过屏的 3/4 会先看到一段空白，再看到字冒出来。
 */
function validateAnim(where, sc, aspect) {
  const list = sc.anim;
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    err(`${where}.anim`, 'anim 不是数组', '[{ "target": "title", "delay": 120, "dur": 420 }]');
    return;
  }
  if (!list.length) return;
  if (list.length > 6) {
    err(`${where}.anim`, `${list.length} 条 anim，超过 6 条`, '一屏最多强调 6 个元素，再多等于没有节奏');
  }

  const durMs = (Number(sc.dur) || 6) * 1000;
  const allowed = ANIM_TARGETS[aspect];
  const textSrc = sc.quote ?? sc.title ?? '';

  list.forEach((a, j) => {
    const at = `${where}.anim[${j}]`;
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      err(at, '不是对象', '{ "target": "title", "delay": 120 }');
      return;
    }
    for (const k of Object.keys(a)) {
      if (!ANIM_FIELDS.includes(k)) err(`${at}.${k}`, `未知字段 "${k}"`, `可选用：${ANIM_FIELDS.join(' / ')}`);
    }
    if (!a.target) err(`${at}.target`, '缺 target', `可选用：${allowed.join(' / ')}`);
    else if (!allowed.includes(a.target)) {
      err(`${at}.target`, `${aspect === 'wide' ? '横屏' : '竖屏'}没有 "${a.target}"`,
        `可选用：${allowed.join(' / ')}`);
    }
    for (const [k, [lo, hi]] of Object.entries(ANIM_LIMIT)) {
      if (a[k] === undefined) continue;
      const v = Number(a[k]);
      if (!Number.isFinite(v)) err(`${at}.${k}`, `"${a[k]}" 不是数字`, `写成 ${lo}–${hi} 之间的数`);
      else if (v < lo || v > hi) err(`${at}.${k}`, `${v} 超出 ${lo}–${hi}`, '按毫秒 / 像素量级重写');
    }
    if (a.ease !== undefined && !ANIM_EASE.includes(a.ease)) {
      err(`${at}.ease`, `未知缓动 "${a.ease}"`, `可选用：${ANIM_EASE.join(' / ')}`);
    }

    const delay = Number(a.delay) || 0;
    const span = a.dur === undefined ? (a.target === 'chars' ? 320 : 420) : Number(a.dur);
    const gap = Number(a.stagger) || 0;
    const rows = a.target === 'title' ? Math.max(1, toLines(textSrc).length)
      : a.target === 'chars' ? Math.max(1, charCount(toLines(textSrc).join('')))
      : 1;
    const done = delay + span + gap * Math.max(0, rows - 1);
    if (done > durMs * 0.75) {
      warn(at, `入场到 ${(done / 1000).toFixed(2)}s 才结束（屏长 ${(durMs / 1000).toFixed(2)}s）`, 
        `delay 压到 ${Math.max(0, Math.round(durMs * 0.5 - span))}ms 以内，否则先空一段再出字`);
    }
  });
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

    validateAnim(w, sc, 'portrait');
  });

  if (total < DUR.totalMin) warn('scenes', `总时长 ${total}s < ${DUR.totalMin}s`, '抖音知识类完播友好区间 40–70s');
  if (total > DUR.totalMax) err('scenes', `总时长 ${total}s > ${DUR.totalMax}s`, '砍场景，不要砍单场景时长');

  // 节奏检查：开场钩子必须短
  if (scenes[0] && scenes[0].type !== 'hook') warn('scenes[0]', '开场不是 hook', '前 3 秒决定划走率，第一屏必须是钩子');
  if (scenes[0] && Number(scenes[0].dur) > 6) warn('scenes[0].dur', '开场超过 6s', '钩子要快，4–5s 足够');

  return null;
}

// ---------------------------------------------------------------- 横屏校验
/**
 * 横屏 story 的字段和竖屏完全不同：
 *   { id, dur, layout, kicker, kickerEn, title[], body, node, ...node 私有参数 }
 * 没有 type / fx，所以不能复用竖屏那套 validate()。
 */
function validateWide(story, period, enums) {
  if (!story || typeof story !== 'object') { err('root', 'story 不是对象', '检查 JSON 语法'); return; }
  const scenes = story.scenes;
  if (!Array.isArray(scenes) || scenes.length < 3) {
    err('scenes', '场景数不足 3 个', '一条 50–60s 的横屏片通常 8–14 屏');
    return;
  }
  if (scenes.length > 20) warn('scenes', `场景 ${scenes.length} 个，偏多`, '横屏单屏信息量大，超过 20 屏节奏会散');

  const meta = story.meta || (story.meta = {});
  meta.series = meta.series ?? '';
  meta.handle = meta.handle ?? '@你的账号';
  if (charCount(meta.series) > 26) warn('meta.series', '系列名超过 26 字符，会挤压右侧期号', '缩到 26 以内');
  if (charCount(meta.handle) > 16) warn('meta.handle', '账号名超过 16 字符，右下角会溢出', '缩到 16 以内');

  let total = 0;
  scenes.forEach((sc, i) => {
    const w = `scenes[${i}]${sc.id ? `(${sc.id})` : ''}`;

    // ① 时长必须落在拍网格上：模板内部用 BEAT_P 算冲击/脉冲，dur 一旦不在网格，切点和画面动作会错开
    const dur = Number(sc.dur);
    if (!Number.isFinite(dur)) {
      err(`${w}.dur`, `时长 "${sc.dur}" 不是数字`, '按朗读 5–6 字/秒估，写成拍长整数倍');
      return;
    }
    const k = Math.max(1, Math.round(dur / period));
    const snapped = +(k * period).toFixed(4);
    if (Math.abs(snapped - dur) > 0.02) {
      warn(`${w}.dur`, `${dur}s 不在拍点，已吸到 ${snapped}s（${k} 拍）`,
        `直接写 ${snapped}，或 ${(8 * period).toFixed(2)}（8 拍）/ ${(16 * period).toFixed(2)}（16 拍）`);
    }
    sc.dur = snapped;
    total += snapped;
    if (k < WIDE_BUDGET.beatsMin) err(`${w}.dur`, `只有 ${k} 拍（${snapped}s），横屏读不完`,
      `至少 ${WIDE_BUDGET.beatsMin} 拍 ≈ ${(WIDE_BUDGET.beatsMin * period).toFixed(2)}s`);
    if (k > WIDE_BUDGET.beatsMax) err(`${w}.dur`, `${k} 拍（${snapped}s）太长`, '超过 9.5s 观众会划走，拆屏');
    if (k % 4 !== 0) warn(`${w}.dur`, `${k} 拍不是 4 的倍数，切点不落小节`, '对齐到 8 / 12 / 16 拍');

    // ② 版式与图形母题：枚举来自模板本身，不在代码里写死
    if (!sc.layout) err(`${w}.layout`, '缺 layout 字段', `可选用：${enums.layouts.join(' / ')}`);
    else if (!enums.layouts.includes(sc.layout)) err(`${w}.layout`, `未知版式 "${sc.layout}"`, `可选用：${enums.layouts.join(' / ')}`);
    if (sc.node && sc.node !== 'none' && !enums.nodes.includes(sc.node)) {
      err(`${w}.node`, `未知图形 "${sc.node}"`, `可选用：${enums.nodes.join(' / ')}`);
    }

    // ③ 标题：formula 屏的 title 是 64px 小标签，不按 152px 主标题算
    const isFormula = sc.layout === 'formula';
    const titles = toLines(sc.title);
    if (!titles.length) err(`${w}.title`, '缺 title', '标题是这一屏的主张');
    if (titles.length > WIDE_BUDGET.titleLines) err(`${w}.title`, `title 有 ${titles.length} 行，最多 ${WIDE_BUDGET.titleLines} 行`, '拆屏');
    if (!isFormula) {
      titles.forEach((ln, j) => {
        const em = emWidth(ln);
        if (em > WIDE_BUDGET.titleEm) {
          err(`${w}.title[${j}]`, `宽 ${em.toFixed(1)} 字 > ${WIDE_BUDGET.titleEm} 字（152px 标题会缩到 112px 以下）`,
            `删约 ${Math.ceil(em - WIDE_BUDGET.titleEm)} 个字`);
        }
      });
    }
    const emCount = titles.join('').match(/<em>/g)?.length || 0;
    if (emCount > WIDE_BUDGET.emLines) err(`${w}.title`, `<em> 高亮 ${emCount} 处，最多 ${WIDE_BUDGET.emLines} 处`, '一屏只强调一个词，多了等于没强调');

    // ④ 正文
    const bodies = String(sc.body ?? '').split('\n').filter(l => l.trim());
    if (bodies.length > WIDE_BUDGET.bodyLines) err(`${w}.body`, `body 有 ${bodies.length} 行，最多 ${WIDE_BUDGET.bodyLines} 行`, '拆屏或删句');
    bodies.forEach((ln, j) => {
      const em = emWidth(ln);
      if (em > WIDE_BUDGET.bodyEm) {
        err(`${w}.body[${j}]`, `宽 ${em.toFixed(1)} 字 > ${WIDE_BUDGET.bodyEm} 字`, `删约 ${Math.ceil(em - WIDE_BUDGET.bodyEm)} 个字`);
      }
    });

    // ⑤ 眉标
    if (sc.kicker && emWidth(sc.kicker) > WIDE_BUDGET.kickerEm) {
      err(`${w}.kicker`, `宽 ${emWidth(sc.kicker).toFixed(1)} 字 > ${WIDE_BUDGET.kickerEm} 字`, '眉标是标签不是句子');
    }

    validateAnim(w, sc, 'wide');
  });

  if (total < WIDE_BUDGET.totalMin) warn('scenes', `总时长 ${total.toFixed(2)}s < ${WIDE_BUDGET.totalMin}s`, '横屏完播友好区间 50–65s');
  if (total > WIDE_BUDGET.totalMax) err('scenes', `总时长 ${total.toFixed(2)}s > ${WIDE_BUDGET.totalMax}s`, '砍屏幕，不要砍单屏时长');
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

/**
 * 横屏模板的注入点和竖屏不同：
 *  - story 走 <script id="story-data">/*__STORY__*\/</script> 这个占位符
 *  - 拍长/相位是模板里的常量，构建时用 beats.json 的真实值覆盖，
 *    换 BGM 后只要重跑 beat.mjs，不用手改模板
 */
function injectWide(template, story, period, phase) {
  const json = JSON.stringify(story, null, 0).replace(/</g, '\\u003c');

  let html = template.replace(/url\("fonts\/([^"]+)"\)/g, (_m, f) => {
    const abs = path.join(FONT_DIR, f);
    return `url("${pathToFileURL(abs).href}")`;
  });

  if (!html.includes('/*__STORY__*/')) throw new Error('横屏模板结构变了：找不到 /*__STORY__*/ 锚点');
  html = html.replace('/*__STORY__*/', `window.__STORY__ = ${json};`);

  const beatRe = /const BEAT_P = [\d.]+, BEAT_PH = [\d.]+;/;
  if (!beatRe.test(html)) throw new Error('横屏模板结构变了：找不到 BEAT_P / BEAT_PH 常量');
  html = html.replace(beatRe, `const BEAT_P = ${period}, BEAT_PH = ${phase};`);

  return html;
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

// 卡点表先读：横屏校验要用 period 把 dur 吸到拍网格上，所以不能等校验之后
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
  } catch (e) {
    if (!QUIET) console.error(`[build] 跳过卡点：${e.message}（跑 scripts/beat.mjs 生成 assets/beats.json）`);
    beatData = null;
  }
}
const PERIOD = Number(beatData?.period) || 0.53142;
const PHASE = Number.isFinite(Number(beatData?.phase)) ? Number(beatData.phase) : 0.0702;

const template = await readFile(TEMPLATE, 'utf8');

if (WIDE) validateWide(story, PERIOD, templateEnums(template));
else validate(story);

if (!QUIET) {
  const scenes = story.scenes || [];
  const total = scenes.reduce((a, s) => a + (Number(s.dur) || 0), 0);
  console.error(`[build] 画幅 ${WIDE ? '横屏 1920×1080' : '竖屏 1080×1920'} · 场景 ${scenes.length} 个`
    + ` · 总时长 ${total.toFixed(2)}s · 平均 ${(total / Math.max(1, scenes.length)).toFixed(1)}s/屏`);

  if (WIDE) {
    scenes.forEach((s, i) => {
      const k = Math.round(Number(s.dur) / PERIOD);
      const titles = toLines(s.title);
      const maxEm = titles.length
        ? Math.max(...titles.map(l => emWidth(l)))
        : 0;
      console.error(`  ${String(i + 1).padStart(2)}. ${String(s.id || '').padEnd(4)}`
        + ` ${String(s.dur).padStart(6)}s ${String(k).padStart(2)}拍`
        + ` ${String(s.layout || '-').padEnd(8)} ${String(s.node || '-').padEnd(14)}`
        + ` 标题 ${maxEm.toFixed(1)}字`);
    });
  } else {
    scenes.forEach((s, i) => {
      const kind = s.type === 'quote' ? 'quote' : s.type === 'stat' ? 'label' : 'title';
      const lines = toLines(s[kind]);
      const px = lines.length ? Math.min(...lines.map(l => estMetry(kind, l).px)) : 0;
      const tag = s.type.padEnd(5);
      console.error(`  ${String(i + 1).padStart(2)}. ${tag} ${String(s.dur).padStart(4)}s  ${kind} ${String(px).padStart(3)}px`);
    });
  }
  warns.forEach(w => console.error(`  [警告] ${w.where}：${w.msg}\n          → ${w.fix}`));
  errors.forEach(e => console.error(`  [错误] ${e.where}：${e.msg}\n          → ${e.fix}`));
}

if (errors.length || (STRICT && warns.length)) {
  console.error(`[build] 未通过：${errors.length} 个错误，${warns.length} 个警告。先改 story.json，不要渲。`);
  process.exit(1);
}

// 卡点：把切屏推到音乐击打上。
// 横屏不走这一步——它要求 dur 本身就是拍长的整数倍（见 validateWide），
// 再由模板用 BEAT_P 推算画面内部动作，两套机制混用会互相打架。
let beatInfo = null;
if (!WIDE && beatData) {
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
}

// 节拍可视化层：只有竖屏模板消费 __BEATS__；横屏模板自己用 BEAT_P/BEAT_PH 推拍点
let beatsForVisual = null;
if (!WIDE && beatData && Array.isArray(beatData.onsets) && beatData.onsets.length) {
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

const html = WIDE
  ? injectWide(template, story, PERIOD, PHASE)
  : inject(template, story, beatsForVisual);
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, html, 'utf8');

console.log(JSON.stringify({
  ok: true,
  html: OUT,
  aspect: WIDE ? 'wide' : 'portrait',
  resolution: WIDE ? '1920x1080' : '1080x1920',
  scenes: story.scenes.length,
  duration: +story.scenes.reduce((a, s) => a + (Number(s.dur) || 0), 0).toFixed(2),
  beat: beatInfo,
  beatVisual: beatsForVisual ? beatsForVisual.onsets.length : 0,
  warnings: warns,
}, null, 2));
