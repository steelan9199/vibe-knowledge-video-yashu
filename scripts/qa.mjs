#!/usr/bin/env node
/**
 * qa.mjs — 排版体检（负反馈回路的「测量」环节）
 *
 * 设计原则：**用测量代替看图**。
 * 一张 1080x1920 截图 ≈ 1.5k token；本脚本一次体检全片 ≈ 300 token，
 * 且直接给出「改哪里、怎么改」，模型不需要看图判断。
 *
 * 用法：
 *   node qa.mjs --html out/story.html                 # 人类可读摘要（省 token，默认）
 *   node qa.mjs --html out/story.html --video out/x.mp4  # 附带黑屏/静帧检测
 *   node qa.mjs --html out/story.html --json          # 完整结构化（调试用）
 *
 * 退出码：0 通过 / 1 有错误级违规
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const W = 1080, H = 1920;
let PAD_X = 96, SAFE_TOP = 172, SAFE_BOTTOM = 360;  // 实际值从模板 CSS 变量读，见下方 syncSpec

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (k) => argv.includes('--' + k);
const HTML = path.resolve(arg('html', 'out/story.html'));
const VIDEO = arg('video') ? path.resolve(arg('video')) : null;
const AS_JSON = flag('json');
const SAMPLE_AT = Number(arg('at', 0.72));   // 场景内采样点
const MAX_LINES = Number(arg('max-lines', 40)); // 输出行数上限，防 token 爆炸
const SHEET = arg('sheet') ? path.resolve(arg('sheet')) : null; // 联系图输出路径
const VIDEO_ONLY = flag('video-only'); // 只测成片，跳过几何体检

if (!VIDEO_ONLY && !existsSync(HTML)) {
  console.error(`[qa] 找不到 ${HTML}`);
  process.exit(1);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- 浏览器
function findBrowser() {
  const c = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium',
  ];
  for (const p of c) if (existsSync(p)) return p;
  console.error('[qa] 找不到 Edge/Chrome');
  process.exit(1);
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP 关闭'));
      this.pending.clear();
    });
  }
  static async connect(url, ms = 15000) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('CDP 连接超时')), ms);
      ws.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('CDP 连接失败')); }, { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

// ---------------------------------------------------------------- 页面内测量
const MEASURE = `(() => {
  const W = ${W}, H = ${H};
  const stage = document.getElementById('stage');
  const sr = stage.getBoundingClientRect();
  const s = sr.width / W || 1;
  const loc = (r) => ({
    left: (r.left - sr.left) / s, right: (r.right - sr.left) / s,
    top: (r.top - sr.top) / s, bottom: (r.bottom - sr.top) / s,
    w: r.width / s, h: r.height / s,
  });
  const SEL = [['.kicker','kicker'],['.title','title'],['.qtext','quote'],['.body','body'],
               ['.cite','cite'],['.num','num'],['.unit','unit'],['.label','label'],['.qmark','qmark']];
  const blocks = [];
  for (const [sel, kind] of SEL) {
    const el = document.querySelector('.scene.on ' + sel);
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) continue;
    const r = loc(el.getBoundingClientRect());
    if (r.w < 4 || r.h < 4) continue;
    blocks.push({ kind, rect: r, fontSize: parseFloat(cs.fontSize),
      clippedX: el.scrollWidth > el.clientWidth + 2,
      clippedY: el.scrollHeight > el.clientHeight + 2 });
  }
  let fx = null;
  const cv = document.getElementById('fx');
  if (cv) {
    const d = cv.getContext('2d').getImageData(0, 0, W, H).data;
    let minX = W, minY = H, maxX = -1, maxY = -1, ink = 0;
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      if (d[(y * W + x) * 4 + 3] > 8) { ink++; if (x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; }
    }
    fx = maxX < 0 ? { empty: true } : { empty:false, left:minX, right:maxX, top:minY, bottom:maxY,
      inkRatio: +(ink / (W*H/4) * 100).toFixed(2) };
  }
  return JSON.stringify({ blocks, fx });
})()`;

// ---------------------------------------------------------------- 违规判定
const S = []; // violations
const add = (sev, type, scene, detail, fix) => S.push({ sev, type, scene, detail, fix });

// 只做成片终检：不启动浏览器，也不重复打印几何报告（那部分上一次已经报过了）
if (VIDEO_ONLY) {
  if (!VIDEO) { console.error('[qa] --video-only 需要 --video <文件>'); process.exit(1); }
  if (!existsSync(VIDEO)) { console.error(`[qa] 找不到 ${VIDEO}`); process.exit(1); }
  for (const h of await blackDetect(VIDEO)) {
    add('err', 'black-frame', '-', `${h.start.toFixed(2)}s 起黑屏 ${h.dur.toFixed(2)}s`, '该屏进场淡入太快，或 fx 未绘制');
  }
  const hits = S.filter(x => x.sev === 'err');
  hits.forEach(x => console.log(`  错误 ${x.type.padEnd(12)} ${x.detail}  → ${x.fix}`));
  console.log(`[qa] 成片终检：${hits.length ? `${hits.length} 处黑屏，未通过` : '无黑屏，通过'}`);
  process.exit(hits.length ? 1 : 0);
}

const MIN_PX = { title: 56, quote: 40, body: 34, label: 30, cite: 18, kicker: 20, num: 120, unit: 26 };
const TEXTY = ['title', 'quote', 'body', 'label'];

function judge(sc, m) {
  const tag = `S${String(sc.i + 1).padStart(2, '0')}`;
  const b = Object.fromEntries(m.blocks.map(x => [x.kind, x]));

  for (const blk of m.blocks) {
    const r = blk.rect;
    if (r.left < PAD_X - 2) add('err', 'safe-left', tag, `${blk.kind} 左边缘 ${r.left.toFixed(0)}px < ${PAD_X}`, '减少单行字数');
    if (r.right > W - PAD_X + 2) add('err', 'safe-right', tag, `${blk.kind} 右边缘超出 ${(r.right - (W - PAD_X)).toFixed(0)}px`, '减少单行字数（右侧是按钮区）');
    if (r.top < SAFE_TOP - 4 && blk.kind !== 'kicker') add('err', 'safe-top', tag, `${blk.kind} 顶端 ${r.top.toFixed(0)}px 侵入顶部安全区`, '减少行数');
    if (r.bottom > H - SAFE_BOTTOM + 2) add('err', 'safe-bottom', tag, `${blk.kind} 底部 ${r.bottom.toFixed(0)}px 越过 ${H - SAFE_BOTTOM}px 边界（超 ${(r.bottom - (H - SAFE_BOTTOM)).toFixed(0)}px）`, '该屏减 1 行字，或拆到下一屏');
    const min = MIN_PX[blk.kind];
    if (min && blk.fontSize < min - 0.5) add('err', 'font-small', tag, `${blk.kind} 字号 ${blk.fontSize}px < ${min}px`, '减字，不要缩字号硬塞');
  }

  // 引号是装饰字形，墨迹只占 em 框上沿，与正文盒子交叠属设计意图
  const keys = Object.keys(b).filter(k => k !== 'qmark');
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const A = b[keys[i]].rect, B = b[keys[j]].rect;
    const ox = Math.min(A.right, B.right) - Math.max(A.left, B.left);
    const oy = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
    if (ox > 4 && oy > 4) add('err', 'overlap', tag, `${keys[i]}×${keys[j]} 交叠 ${oy.toFixed(0)}px 高`, '删元素或缩字号（最严重的排版错误）');
  }

  const ambient = sc.fx === 'particles';   // 粒子是全屏环境层，不参与几何约束
  if (m.fx && !m.fx.empty && !ambient) {
    if (m.fx.bottom > H - SAFE_BOTTOM + 6) add('err', 'fx-intrudes', tag, `图形底部 ${m.fx.bottom}px 进入文案区`, '图形上移或降高');
    if (b.body && m.fx.top < b.body.rect.bottom - 2) add('err', 'fx-overlap-text', tag, `图形顶端 ${m.fx.top}px 压住正文底部 ${b.body.rect.bottom.toFixed(0)}px`, '正文减 1 行');
    if (m.fx.top - (b.body?.rect.bottom ?? 0) < 20 && m.fx.top > (b.body?.rect.bottom ?? 0)) {
      add('warn', 'fx-tight', tag, `图形与正文仅 ${(m.fx.top - b.body.rect.bottom).toFixed(0)}px 间隙`, '加大间距会更透气');
    }
    if (m.fx.inkRatio < 0.15) add('warn', 'fx-faint', tag, `图形墨量仅 ${m.fx.inkRatio}%`, '图形太淡，看不清');
  }

  // 文本密度：整屏可见文字量，过低=空，过高=挤
  const textArea = m.blocks.filter(x => TEXTY.includes(x.kind)).reduce((a, x) => a + x.rect.w * x.rect.h, 0);
  const ratio = textArea / (W * H) * 100;
  if (ratio > 34) add('warn', 'too-dense', tag, `文字覆盖 ${ratio.toFixed(0)}% 画面`, '拆场景，信息量过大');
  // stat 屏的主体是一个 300px+ 的大数字，面积占比天然很低——按文字密度判空是误报
  if (ratio < 2.5 && sc.type !== 'stat') add('warn', 'too-sparse', tag, `文字仅覆盖 ${ratio.toFixed(0)}% 画面`, '画面偏空，可加一句或加大字号');
  return ratio;
}

// ---------------------------------------------------------------- 黑屏检测
function blackDetect(file) {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-i', file, '-vf',
      'blackdetect=d=0.12:pix_th=0.04', '-an', '-f', 'null', '-'],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('close', () => {
      const hits = [...err.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)]
        .map(m => ({ start: +m[1], dur: +m[3] }));
      resolve(hits.filter(h => h.start > 0.15)); // 开场渐入不算
    });
    p.on('error', () => resolve([]));
  });
}

// ---------------------------------------------------------------- 主流程
const workDir = await mkdtemp(path.join(tmpdir(), 'vibe-qa-'));
const profile = path.join(workDir, 'profile');
await mkdir(profile, { recursive: true });

const proc = spawn(findBrowser(), [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--hide-scrollbars', '--mute-audio', '--allow-file-access-from-files',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--force-device-scale-factor=1', '--font-render-hinting=none', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let errBuf = '';
proc.stderr.on('data', d => { errBuf += d.toString(); });

let cdp, sid;
const density = [];
let SCENE_COUNT = 0, DURATION = 0;

try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 300 && !port; i++) {
    if (existsSync(portFile)) port = parseInt((await readFile(portFile, 'utf8').catch(() => '')).split('\n')[0], 10) || 0;
    if (!port) await sleep(60);
  }
  if (!port) throw new Error('调试端口未就绪 ' + errBuf.slice(-500));

  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  cdp = await Cdp.connect(v.webSocketDebuggerUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  sid = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sid);
  await cdp.send('Page.navigate', { url: pathToFileURL(HTML).href }, sid);

  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };

  let ready = false;
  for (let i = 0; i < 400 && !ready; i++) {
    ready = await ev('window.__ready === true && typeof window.seek === "function"').catch(() => false);
    if (!ready) await sleep(80);
  }
  if (!ready) throw new Error('页面未就绪 ' + await ev('JSON.stringify({r:window.__ready,e:window.__error||null})').catch(() => ''));

  const duration = Number(await ev('Number(window.__duration)||0'));
  DURATION = duration;
  const scenes = JSON.parse(await ev('JSON.stringify(window.__scenes||[])'));
  if (!scenes.length) throw new Error('页面未暴露 __scenes');
  SCENE_COUNT = scenes.length;

  // 安全区取自模板自己的 CSS 变量：改模板即生效，qa 不会与真实版式脱节
  const spec = JSON.parse(await ev(
    "JSON.stringify((()=>{const cs=getComputedStyle(document.documentElement);" +
    "const n=v=>parseFloat(cs.getPropertyValue(v))||0;" +
    "return {padX:n('--pad-x'),safeTop:n('--safe-top'),safeBottom:n('--safe-bottom')}})())"
  ));
  if (spec.padX > 0) { PAD_X = spec.padX; SAFE_TOP = spec.safeTop; SAFE_BOTTOM = spec.safeBottom; }

  const missing = JSON.parse(await ev('JSON.stringify(window.__fonts||[])'));
  if (missing.length) add('err', 'font-missing', '-', `字体未加载：${missing.join(', ')}`, '检查 assets/fonts 与 @font-face');

  const shots = [];
  for (const sc of scenes) {
    const t = (sc.start + sc.dur * SAMPLE_AT) / duration;
    await ev(`(async()=>{window.seek(${t.toFixed(6)});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true})()`);
    const m = JSON.parse(await ev(MEASURE));
    density.push({ scene: `S${sc.i + 1}`, type: sc.type, ratio: +judge(sc, m).toFixed(1) });

    // 联系图：单屏缩到 28% 采样，最后拼成一张，用 1 张图代替 N 张
    if (SHEET) {
      const r = await cdp.send('Page.captureScreenshot', {
        format: 'jpeg', quality: 82,
        clip: { x: 0, y: 0, width: W, height: H, scale: 0.28 },
      }, sid);
      shots.push(r.data);
    }
  }

  // 拼图：新开一个页面按网格排好再截一次
  if (SHEET && shots.length) {
    const tw = Math.round(W * 0.28), th = Math.round(H * 0.28);
    const cols = Math.min(4, shots.length), rows = Math.ceil(shots.length / cols);
    const cells = shots.map((d, i) => `<div style="position:relative">
      <img src="data:image/jpeg;base64,${d}" style="display:block;width:${tw}px;height:${th}px">
      <span style="position:absolute;left:0;top:0;color:#7CF;font:600 ${Math.round(tw/14)}px monospace;background:#000B;padding:2px 7px">S${i + 1}</span>
    </div>`).join('');
    const sheetHtml = `<body style="margin:0;background:#000;display:grid;grid-template-columns:repeat(${cols},${tw}px);gap:0">${cells}</body>`;
    const sheetFile = path.join(workDir, 'sheet.html');
    await writeFile(sheetFile, sheetHtml, 'utf8');

    const { targetId: t2 } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const s2 = (await cdp.send('Target.attachToTarget', { targetId: t2, flatten: true })).sessionId;
    await cdp.send('Page.enable', {}, s2);
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: tw * cols, height: th * rows, deviceScaleFactor: 1, mobile: false }, s2);
    await cdp.send('Page.navigate', { url: pathToFileURL(sheetFile).href }, s2);
    await sleep(400);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, s2);
    await writeFile(SHEET, Buffer.from(shot.data, 'base64'));
    console.error(`[qa] 联系图已存 ${SHEET}（${tw * cols}x${th * rows}，${shots.length} 屏）`);
  }

  if (VIDEO) {
    if (!existsSync(VIDEO)) add('warn', 'video-missing', '-', `找不到 ${VIDEO}`, '先出片再测黑屏');
    else (await blackDetect(VIDEO)).forEach(h =>
      add('err', 'black-frame', '-', `${h.start.toFixed(2)}s 处黑屏 ${h.dur.toFixed(2)}s`, '场景进场淡入太快或 fx 未绘制，检查 vis 区间'));
  }

  await cdp.send('Browser.close').catch(() => {});
  cdp.close();
} catch (e) {
  cdp?.close();
  try { proc.kill('SIGKILL'); } catch {}
  console.error(`[qa] 失败：${e.message}`);
  process.exit(1);
}

try { proc.kill('SIGKILL'); } catch {}
await rm(workDir, { recursive: true, force: true }).catch(() => {});

// ---------------------------------------------------------------- 输出（聚合，省 token）
const errs = S.filter(x => x.sev === 'err');
const warns = S.filter(x => x.sev === 'warn');

if (AS_JSON) {
  console.log(JSON.stringify({ pass: errs.length === 0, errors: errs.length, warnings: warns.length, density, violations: S }, null, 2));
} else {
  const line = (x) => `  ${x.scene.padEnd(4)} ${x.type.padEnd(15)} ${x.detail}\n       → ${x.fix}`;
  // 同类违规合并：一条规则一次说清，避免逐屏刷屏
  const group = (list) => {
    const g = new Map();
    for (const x of list) {
      const k = x.type + '|' + x.fix;
      if (!g.has(k)) g.set(k, { ...x, scenes: [x.scene], details: [x.detail] });
      else { const o = g.get(k); o.scenes.push(x.scene); o.details.push(x.detail); }
    }
    return [...g.values()];
  };

  const out = [];
  const push = (items, label) => {
    for (const g of group(items)) {
      const scenes = [...new Set(g.scenes)].join(',');
      const detail = g.scenes.length > 1
        ? `${g.details.length} 屏受影响：${g.details.slice(0, 2).join('；')}${g.details.length > 2 ? ' …' : ''}`
        : g.details[0];
      out.push(`  ${label} ${g.type.padEnd(14)} ${scenes.padEnd(14)} ${detail}`);
      out.push(`       → ${g.fix}`);
    }
  };
  push(errs, '错误');
  push(warns, '警告');

  const shown = out.slice(0, MAX_LINES);
  const rest = Math.max(0, out.length - MAX_LINES);

  console.log(`[qa] ${SCENE_COUNT} 屏 · ${DURATION.toFixed(1)}s · ${errs.length} 错 / ${warns.length} 警`);
  if (!S.length) {
    console.log(`  通过：无违规`);
  } else {
    shown.forEach(l => console.log(l));
    if (rest) console.log(`  … 另有 ${rest} 行，用 --json 看全量`);
  }
  const dens = density.map(d => `${d.scene}:${d.ratio}%`).join('  ');
  console.log(`  文字密度 ${dens}`);
  console.log(errs.length
    ? `[qa] 未通过（${errs.length} 错 / ${warns.length} 警）。改 story.json 后重跑 build，不要直接 render。`
    : `[qa] 通过（${warns.length} 警）。可以 render。`);
}
process.exit(errs.length ? 1 : 0);
