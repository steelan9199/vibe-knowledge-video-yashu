#!/usr/bin/env node
/**
 * install.mjs — 把仓库里的技能部署到 WorkBuddy 的技能目录
 *
 * 为什么需要：仓库是"源码"，`~/.workbuddy/skills/` 是"运行位置"。
 * 手工 cp 容易漏文件、也容易两边不一致。一条命令搞定，并打印实际变更。
 *
 * 用法：
 *   node scripts/install.mjs                 # 部署到默认技能目录
 *   node scripts/install.mjs --to "D:/x"     # 部署到别处（测试用）
 *   node scripts/install.mjs --dry           # 只看会改什么，不写
 *
 * 不进技能目录的东西：.git / out / demo*.mp4 / node_modules
 *
 * 退出码：0 成功 / 1 失败
 */

import { cp, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const DRY = argv.includes('--dry');
const DEST = path.resolve(
  arg('to', path.join(os.homedir(), '.workbuddy', 'skills', 'vibe-knowledge-video-yashu'))
);

// 只部署这些顶层项；其它一律不带（避免把 out/ 和测试残留装进去）
const INCLUDE = ['SKILL.md', 'story.example.json', 'scripts', 'assets', 'references'];
const SKIP_DIRS = new Set(['.git', 'out', 'node_modules', '.workbuddy']);

async function walk(dir, base = '') {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
    const rel = base ? `${base}/${ent.name}` : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(abs, rel)));
    else if (!/^demo.*\.mp4$/i.test(ent.name)) out.push(rel);
  }
  return out;
}

const hash = async (p) => {
  try {
    return crypto.createHash('sha1').update(await readFile(p)).digest('hex');
  } catch {
    return null;
  }
};

const files = (await Promise.all(
  INCLUDE.map(async (name) => {
    const abs = path.join(ROOT, name);
    if (!existsSync(abs)) return [];
    const s = await stat(abs);
    return s.isDirectory() ? walk(abs, name) : [name];
  })
)).flat();

const changed = [];
for (const rel of files) {
  const a = await hash(path.join(ROOT, rel));
  const b = await hash(path.join(DEST, rel));
  if (a && a !== b) changed.push(rel);
}

if (!DRY) {
  await mkdir(DEST, { recursive: true });
  for (const rel of files) {
    const src = path.join(ROOT, rel);
    const dst = path.join(DEST, rel);
    await mkdir(path.dirname(dst), { recursive: true });
    await cp(src, dst, { force: true });
  }
}

console.log(
  `[install] ${DRY ? '将要部署' : '已部署'} ${changed.length} 个变更 / 共 ${files.length} 个文件 → ${DEST}`
);
if (changed.length) changed.slice(0, 20).forEach((f) => console.log(`  ~ ${f}`));
if (changed.length > 20) console.log(`  … 另有 ${changed.length - 20} 个`);
if (!changed.length) console.log('  运行目录已是最新，无变更');
