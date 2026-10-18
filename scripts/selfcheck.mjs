#!/usr/bin/env node
/**
 * selfcheck.mjs — 技能自检（自进化的「体检」环节）
 *
 * 自进化最大的风险不是「没记经验」，而是「文档说的和代码做的不一样」：
 * SKILL.md 写着某个脚本、某个数字，代码其实已经改了；日志里说改了某个文件，
 * 文件却不存在。这类漂移不会报错，只会在下一次出片时悄悄用错的东西。
 *
 * 所以这个脚本只做机器能判定的事：
 *   ① 所有脚本语法可解析
 *   ② 文档里引用的文件路径真实存在
 *   ③ 安全区数字：模板 CSS 变量 == design-system.md 图示
 *   ④ 经验日志：格式合规、条数未超限、提到的文件存在
 *   ⑤ story.example.json 可解析且类型合法
 *   ⑥ --regress 额外跑一遍旧样例的 build + qa（回归）
 *
 * 用法：
 *   node scripts/selfcheck.mjs
 *   node scripts/selfcheck.mjs --regress
 *
 * 退出码：0 全过 / 1 有问题
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGRESS = process.argv.includes('--regress');
const TYPES = ['hook', 'quote', 'scene', 'stat', 'outro'];

const issues = [];
const bad = (where, msg, fix) => issues.push({ where, msg, fix });
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const has = (p) => existsSync(path.join(ROOT, p));

// ① 脚本语法 ------------------------------------------------------
const scripts = readdirSync(path.join(ROOT, 'scripts')).filter(f => f.endsWith('.mjs'));
for (const f of scripts) {
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, 'scripts', f)], { encoding: 'utf8' });
  if (r.status !== 0) {
    const line = (r.stderr || '').split('\n').find(l => /error/i.test(l)) || '';
    bad('语法', `scripts/${f} 解析失败`, line.trim().slice(0, 90) || 'node --check 该文件查看详情');
  }
}

// ② 文档引用的路径 ------------------------------------------------
const docs = ['SKILL.md', 'README.md',
  ...readdirSync(path.join(ROOT, 'references'))
    .filter(f => f !== 'learnings.md')      // 日志的路径校验在 ④ 里单做，避免同一问题报两遍
    .map(f => 'references/' + f)];
const refRe = /\b((?:scripts|assets|references)\/[\w./\u4e00-\u9fa5-]+\.\w{2,5})/g;
const seen = new Set();
for (const d of docs) {
  for (const m of read(d).matchAll(refRe)) {
    const p = m[1].replace(/[.,;:)]+$/, '');
    if (seen.has(p)) continue;
    seen.add(p);
    if (!has(p) && !p.includes('新歌') && !p.includes('xx')) {
      bad('文档', `${d} 引用了不存在的 ${p}`, '改成真实路径，或从文档里删掉这句');
    }
  }
}

// ③ 规格数字：模板 == 文档 ----------------------------------------
const css = read('assets/template.html');
const vars = {};
for (const k of ['pad-x', 'safe-top', 'safe-bottom']) {
  const m = css.match(new RegExp(`--${k}:\\s*(\\d+)px`));
  if (m) vars[k] = Number(m[1]);
}
const ds = read('references/design-system.md');
const docNum = (re) => { const m = ds.match(re); return m ? Number(m[1]) : null; };
const pairs = [
  ['左右', docNum(/左右\s*(\d+)px/), vars['pad-x']],
  ['顶部', docNum(/顶部\s*(\d+)px/), vars['safe-top']],
  ['底部', docNum(/底部\s*(\d+)px/), vars['safe-bottom']],
];
for (const [label, docV, cssV] of pairs) {
  if (docV == null || cssV == null) {
    bad('规格', `${label}边距没找到可比对的值`, '检查 design-system.md 图示与模板 CSS 变量是否都还在');
  } else if (docV !== cssV) {
    bad('规格', `design-system.md 写 ${label} ${docV}px，模板实际 ${cssV}px`, '改文档对齐模板（模板是唯一事实源）');
  }
}

// ④ 经验日志 ------------------------------------------------------
const journal = read('references/learnings.md');
const sep = journal.indexOf('\n---\n');
const body = sep < 0 ? '' : journal.slice(sep + 5);
const entries = body.split(/\n### /).slice(1).map(x => '### ' + x.trim());
if (sep < 0) bad('日志', 'learnings.md 缺少规则区与记录区的 --- 分隔线', '补一行 ---');
if (entries.length > 40) bad('日志', `${entries.length} 条，超过上限 40`, '把重复问题升级成规则并删掉对应条目');
entries.forEach((e, i) => {
  const title = e.split('\n')[0].replace(/^### /, '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(title)) bad('日志', `第 ${i + 1} 条标题缺日期：${title.slice(0, 24)}`, '格式：### YYYY-MM-DD · 一句话现象');
  for (const field of ['现象', '根因', '改动', '判据']) {
    if (!new RegExp(`-\\s*${field}：`).test(e)) bad('日志', `第 ${i + 1} 条缺「${field}」栏`, '四栏是强制格式，learn.mjs add 会自动生成');
  }
  // 改动栏提到的仓库内文件必须存在
  const fixLine = (e.match(/-\s*改动：(.+)/) || [])[1] || '';
  for (const m of fixLine.matchAll(/((?:scripts|references|assets)\/[\w.-]+\.\w{2,5})/g)) {
    if (!has(m[1])) bad('日志', `第 ${i + 1} 条说改了 ${m[1]}，文件不存在`, '文件名写错了，或该改动没落地');
  }
});

// ⑤ 样例可解析 ----------------------------------------------------
try {
  const ex = JSON.parse(read('story.example.json'));
  if (!Array.isArray(ex.scenes) || !ex.scenes.length) bad('样例', 'story.example.json 没有 scenes', '保证它是可直接跑通的输入');
  (ex.scenes || []).forEach((s, i) => {
    if (!TYPES.includes(s.type)) bad('样例', `第 ${i + 1} 屏类型 "${s.type}" 非法`, `可选：${TYPES.join(' / ')}`);
  });
} catch (e) {
  bad('样例', 'story.example.json 不是合法 JSON', String(e.message).slice(0, 80));
}

// ⑥ 回归 ----------------------------------------------------------
if (REGRESS) {
  const out = path.join(ROOT, 'out', '_selfcheck.html');
  const b = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs'),
    '--story', path.join(ROOT, 'story.example.json'), '--out', out], { encoding: 'utf8' });
  if (b.status !== 0) {
    bad('回归', '旧样例 build 失败', (b.stderr || '').trim().split('\n').slice(-2).join(' / '));
  } else {
    const q = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'qa.mjs'), '--html', out], { encoding: 'utf8' });
    if (q.status !== 0) bad('回归', '旧样例 qa 不通过', (q.stdout || '').trim().split('\n').slice(-3).join(' / '));
  }
}

// 输出 ------------------------------------------------------------
const scope = `${scripts.length} 脚本 · ${seen.size} 文档引用 · ${entries.length} 条日志${REGRESS ? ' · 含回归' : ''}`;
if (!issues.length) {
  console.log(`[check] 通过（${scope}）`);
  process.exit(0);
}
console.log(`[check] ${issues.length} 个问题（${scope}）`);
issues.slice(0, 12).forEach(x => console.log(`  ✗ ${x.where}  ${x.msg}\n     → ${x.fix}`));
if (issues.length > 12) console.log(`  …… 另有 ${issues.length - 12} 个，先修上面这些`);
process.exit(1);
