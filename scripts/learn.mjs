#!/usr/bin/env node
/**
 * learn.mjs — 把一条经验写进 references/learnings.md
 *
 * 存在的理由：经验必须能被写下来才叫沉淀。若让模型自由发挥写散文，
 * 每次格式都不一样，一个月后这个文件就没法读了。所以固定四段式，
 * 一条命令一条记录，输出只有一行。
 *
 * 用法：
 *   node scripts/learn.mjs add --symptom "成片比片子短" \
 *       --cause "-shortest 截断" --fix "render.mjs 加 -stream_loop -1" \
 *       --check "ffprobe 时长 == story 总时长"
 *
 *   node scripts/learn.mjs list          # 最近 10 条标题
 *   node scripts/learn.mjs list --n 30
 *
 * 规则（与 learnings.md 顶部一致）：
 *   - 只记"能改变下次行为"的事实
 *   - 同一问题第二次出现，应升级成 SKILL.md 铁律或 troubleshooting 表格，然后删日志条目
 *   - 上限 40 条，超出自动淘汰最旧
 *
 * 退出码：0 成功 / 1 参数或结构问题
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MAX_ENTRIES = 40;

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const JOURNAL = path.resolve(arg('journal', path.join(ROOT, 'references', 'learnings.md')));

if (!existsSync(JOURNAL)) {
  console.error(`[learn] 找不到 ${JOURNAL}`);
  process.exit(1);
}

const raw = await readFile(JOURNAL, 'utf8');

// 规则区与记录区之间用一条独立的分隔线切开；规则区永远保留
const SEP = '\n---\n';
const sepAt = raw.indexOf(SEP);
if (sepAt < 0) {
  console.error('[learn] learnings.md 结构坏了：找不到规则区与记录区的分隔线 ---');
  process.exit(1);
}
const head = raw.slice(0, sepAt + SEP.length);
const body = raw.slice(sepAt + SEP.length);

/** 记录区按 "\n### " 切成条目 */
function splitEntries(text) {
  return text
    .split(/\n### /)
    .slice(1)
    .map((x) => '### ' + x.trim())
    .filter(Boolean);
}

const entries = splitEntries(body);

const now = new Date();
const stamp = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, '0'),
  String(now.getDate()).padStart(2, '0'),
].join('-');

if (cmd === 'list') {
  const n = Number(arg('n', 10));
  const slice = entries.slice(0, n);
  if (!slice.length) {
    console.log('[learn] 日志为空');
  } else {
    slice.forEach((e) => console.log('  ' + e.split('\n')[0].replace(/^### /, '')));
  }
  console.log(`  共 ${entries.length} 条（上限 ${MAX_ENTRIES}）`);
  process.exit(0);
}

if (cmd === 'add') {
  const symptom = arg('symptom');
  const cause = arg('cause');
  const fix = arg('fix');
  const check = arg('check');

  if (!symptom || !cause || !fix) {
    console.error('[learn] 至少要有 --symptom --cause --fix；--check 建议也给（否则下次无从判断改对没有）');
    process.exit(1);
  }

  const entry = [
    `### ${stamp} · ${symptom}`,
    `- 现象：${symptom}`,
    `- 根因：${cause}`,
    `- 改动：${fix}`,
    `- 判据：${check || '（未写，补一条可执行的检查）'}`,
  ].join('\n');

  // 新的放最前：日志是倒序的，最近的经验最该被看到
  const next = [entry, ...entries].slice(0, MAX_ENTRIES);
  const out = head + '\n' + next.join('\n\n') + '\n';
  await writeFile(JOURNAL, out, 'utf8');

  const dropped = Math.max(0, entries.length + 1 - MAX_ENTRIES);
  console.log(
    `[learn] 已记录：${symptom}` +
      (dropped ? `（超出上限，淘汰 ${dropped} 条最旧）` : '') +
      ` · 现有 ${next.length} 条`
  );
  process.exit(0);
}

console.error('[learn] 用法：add --symptom ... --cause ... --fix ... [--check ...] | list [--n 10]');
process.exit(1);
