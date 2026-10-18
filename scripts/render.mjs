#!/usr/bin/env node
/**
 * render.mjs — Vibe 知识视频渲染引擎（零 npm 依赖）
 *
 * 链路：单文件 HTML 动画 → Chrome 无头逐帧截图 → FFmpeg 合成 MP4
 * 依赖：Node >= 22（需全局 WebSocket）、本机 Chrome/Edge、ffmpeg
 *
 * 用法：
 *   node render.mjs --html ./story.html --out ./out/video.mp4
 *   node render.mjs --html story.html --duration 60 --fps 30 --bgm ./bgm.mp3
 *   node render.mjs --html story.html --limit 60      # 只渲前 60 帧，快速验片
 *
 * 退出码：0 成功 / 1 失败
 */

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile, readFile, stat, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv);
const HTML = args.html;
if (!HTML) fail('缺少 --html 参数');

const FPS = Number(args.fps || 30);
const WIDTH = Number(args.width || 1080);
const HEIGHT = Number(args.height || 1920);
const OUT = path.resolve(args.out || './out/video.mp4');
const FORMAT = String(args.format || 'png').toLowerCase(); // png | jpeg
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const DEFAULT_BGM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'bgm', 'vibe.mp3');
const BGM_OFF = args.bgm === 'none' || args.bgm === 'off' || args.bgm === 'false';
const BGM = BGM_OFF ? null
  : (args.bgm && args.bgm !== true) ? path.resolve(args.bgm)
  : (existsSync(DEFAULT_BGM) ? DEFAULT_BGM : null);
const BGM_SYNTH = args.bgm === 'synth' || args['bgm-synth'] === true;
const KEEP_FRAMES = Boolean(args['keep-frames']);
const FRAMES_DIR_ARG = args['frames-dir'] ? path.resolve(args['frames-dir']) : null;
const CRF = String(args.crf || 18);
const PRESET = String(args.preset || 'medium');
const QUIET = Boolean(args.quiet);

function fail(msg) {
  console.error(`[render] 错误：${msg}`);
  process.exit(1);
}
const log = (...m) => { if (!QUIET) console.error(...m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- chrome
function findBrowser() {
  if (args.browser) return args.browser;
  if (args.chrome) return args.chrome; // 兼容旧参数
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  fail('找不到 Edge/Chrome，请用 --browser <路径> 指定');
}

function findFfmpeg() {
  if (args.ffmpeg) return args.ffmpeg;
  return 'ffmpeg'; // 交给 PATH；缺失时 ffmpeg 步骤会报错并给出提示
}

function run(cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: opts.stdio || ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    p.stdout?.on('data', (d) => { out += d; opts.onStdout?.(d.toString()); });
    p.stderr?.on('data', (d) => { err += d; opts.onStderr?.(d.toString()); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} 退出码 ${code}\n${err.slice(-2000)}`))));
  });
}

// ---------------------------------------------------------------- 极简 CDP 客户端
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`CDP ${msg.error.message} (${msg.error.code})`)) : resolve(msg.result);
      }
    });
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP 连接关闭'));
      this.pending.clear();
    });
  }

  static async connect(url, timeoutMs = 15000) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket 连接失败')); }, { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() { try { this.ws.close(); } catch { /* noop */ } }
}

async function waitForPort(portFile, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(portFile)) {
      const txt = await readFile(portFile, 'utf8').catch(() => '');
      const port = parseInt(txt.split('\n')[0], 10);
      if (port > 0) return port;
    }
    await sleep(60);
  }
  throw new Error('等待 Chrome 调试端口超时');
}

// ---------------------------------------------------------------- 主流程
(async () => {
  const tStart = Date.now();
  const htmlPath = path.resolve(HTML);
  if (!existsSync(htmlPath)) fail(`HTML 不存在：${htmlPath}`);

  const browser = findBrowser();
  const ffmpeg = findFfmpeg();
  log(`[render] Browser: ${browser}`);

  // 帧输出目录
  const workDir = FRAMES_DIR_ARG || await mkdtemp(path.join(tmpdir(), 'vibe-frames-'));
  const framesDir = path.join(workDir, 'frames');
  await rm(framesDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(framesDir, { recursive: true });
  await mkdir(path.dirname(OUT), { recursive: true });

  const userDataDir = path.join(workDir, 'browser-profile');
  await mkdir(userDataDir, { recursive: true });

  // 1) 启动无头 Chrome
  const browserArgs = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--mute-audio',
    '--allow-file-access-from-files',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--force-device-scale-factor=1',
    '--font-render-hinting=none',
    '--run-all-compositor-stages-before-draw',
    '--disable-new-content-rendering-timeout',
    'about:blank',
  ];
  const browserProc = spawn(browser, browserArgs, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let browserErr = '';
  browserProc.stderr.on('data', (d) => { browserErr += d.toString(); });

  let cdp, sessionId, chromePid = browserProc.pid;
  try {
    const port = await waitForPort(path.join(userDataDir, 'DevToolsActivePort')).catch((e) => {
      throw new Error(`${e.message}\nBrowser stderr:\n${browserErr.slice(-1500)}`);
    });

    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);

    // 2) 新开 target
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = attached.sessionId;

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
    }, sessionId);

    // 3) 打开页面
    const fileUrl = pathToFileURL(htmlPath).href;
    log(`[render] 载入 ${fileUrl}`);
    await cdp.send('Page.navigate', { url: fileUrl }, sessionId);

    // 4) 等 __ready
    const readyDeadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: 'window.__ready === true && typeof window.seek === "function"',
        returnByValue: true,
      }, sessionId).catch(() => ({ result: { value: false } }));
      if (r?.result?.value === true) { ready = true; break; }
      await sleep(80);
    }
    if (!ready) {
      const diag = await cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ready: window.__ready, seek: typeof window.seek, err: window.__error || null})',
        returnByValue: true,
      }, sessionId).catch(() => null);
      fail(`页面未就绪（window.__ready !== true）诊断：${diag?.result?.value}\n页面 console 错误请用 --keep-frames 检查 ${htmlPath}`);
    }

    // 5) 读取时长
    let duration = args.duration ? Number(args.duration) : null;
    if (!duration) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: 'Number(window.__duration) || 0', returnByValue: true,
      }, sessionId);
      duration = Number(r?.result?.value) || 0;
    }
    if (!duration || duration <= 0) fail('无法确定时长：页面未设置 window.__duration，也未传 --duration');

    let totalFrames = Math.round(duration * FPS);
    if (LIMIT < totalFrames) totalFrames = LIMIT;
    const step = Number(args.step || 1); // 抽帧调试
    const captureCount = Math.ceil(totalFrames / step);
    log(`[render] ${WIDTH}x${HEIGHT} · ${FPS}fps · ${duration.toFixed(2)}s · ${captureCount} 帧`);

    // 6) 逐帧截图
    const seekExpr = (t) => `(async () => {
      window.seek(${t});
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return true;
    })()`;

    const t0 = Date.now();
    for (let i = 0; i < totalFrames; i += step) {
      const t = totalFrames === 1 ? 0 : i / (totalFrames - 1);
      await cdp.send('Runtime.evaluate', {
        expression: seekExpr(t.toFixed(6)), awaitPromise: true, returnByValue: true,
      }, sessionId);

      const shot = await cdp.send('Page.captureScreenshot', {
        format: FORMAT === 'jpeg' ? 'jpeg' : 'png',
        ...(FORMAT === 'jpeg' ? { quality: Number(args.quality || 95) } : {}),
        fromSurface: true,
        captureBeyondViewport: false,
      }, sessionId);

      const idx = String(i / step + 1).padStart(5, '0');
      await writeFile(path.join(framesDir, `f_${idx}.${FORMAT === 'jpeg' ? 'jpg' : 'png'}`), Buffer.from(shot.data, 'base64'));

      if (!QUIET && (i % (step * 15) === 0 || i + step >= totalFrames)) {
        const done = i / step + 1;
        const elapsed = (Date.now() - t0) / 1000;
        const eta = (elapsed / done) * (captureCount - done);
        log(`[render] 帧 ${done}/${captureCount}  ${(100 * done / captureCount).toFixed(0)}%  已用 ${elapsed.toFixed(0)}s  预计剩余 ${eta.toFixed(0)}s`);
      }
    }

    const capSec = (Date.now() - t0) / 1000;
    log(`[render] 截图完成 ${capSec.toFixed(1)}s（${(capSec / captureCount * 1000).toFixed(0)}ms/帧）`);

    // 7) FFmpeg 合成
    const pattern = path.join(framesDir, FORMAT === 'jpeg' ? 'f_%05d.jpg' : 'f_%05d.png');
    const encodeFps = FPS / step; // 抽帧时保持时长不变
    const ffArgs = ['-y', '-framerate', String(encodeFps), '-i', pattern];

    const hasBgm = BGM && existsSync(BGM);
    if (BGM && !hasBgm) console.error(`[render] 警告：找不到音乐 ${BGM}，本片用静音轨`);
    if (hasBgm) {
      // -stream_loop -1 让短音乐循环铺满全片；否则 -shortest 会把成片截到音乐长度
      ffArgs.push('-stream_loop', '-1', '-i', BGM);
    } else if (BGM_SYNTH) {
      // 极简氛围垫音：低频正弦簇 + 缓慢呼吸，长度对齐视频
      const d = (totalFrames / FPS).toFixed(2);
      ffArgs.push('-f', 'lavfi', '-i',
        `aevalsrc=` +
        `0.16*sin(2*PI*55*t)+0.10*sin(2*PI*82.41*t)+0.10*sin(2*PI*110*t)+0.06*sin(2*PI*164.81*t)` +
        `*(0.55+0.45*sin(2*PI*0.07*t))` +
        `:s=48000:d=${d}`);
    } else {
      ffArgs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    }

    ffArgs.push(
      '-c:v', 'libx264',
      '-preset', PRESET,
      '-crf', CRF,
      '-pix_fmt', 'yuv420p',
      '-r', String(FPS),
      ...(hasBgm ? ['-af', `afade=t=out:st=${Math.max(0, totalFrames / FPS - 1.2).toFixed(2)}:d=1.2`] : []),
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
      OUT,
    );

    log(`[render] FFmpeg 编码中…`);
    await run(ffmpeg, ffArgs).catch((e) => fail(`FFmpeg 失败（确认 ffmpeg 在 PATH 中）：\n${e.message}`));

    // 8) 清理
    await cdp.send('Browser.close').catch(() => {});
    cdp.close();
    if (!KEEP_FRAMES && !FRAMES_DIR_ARG) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    } else {
      log(`[render] 帧目录保留：${framesDir}`);
    }

    const info = await stat(OUT);
    const total = ((Date.now() - tStart) / 1000).toFixed(1);
    console.log(JSON.stringify({
      ok: true,
      output: OUT,
      sizeMB: +(info.size / 1048576).toFixed(2),
      duration: +(totalFrames / FPS).toFixed(2),
      fps: FPS,
      resolution: `${WIDTH}x${HEIGHT}`,
      frames: captureCount,
      captureSeconds: +capSec.toFixed(1),
      totalSeconds: +total,
      bgm: hasBgm ? BGM : BGM_SYNTH ? 'synth' : 'silent',
    }, null, 2));
  } catch (e) {
    cdp?.close();
    try { await run('taskkill', ['/PID', String(chromePid), '/T', '/F']).catch(() => {}); } catch { /* noop */ }
    browserProc.kill('SIGKILL');
    fail(e.message);
  }

  // 兜底：确保 Chrome 退出
  browserProc.kill('SIGKILL');
})();
