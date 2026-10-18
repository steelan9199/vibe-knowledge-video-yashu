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
 *   node render.mjs --html story.html --aspect wide        # 横屏 1920×1080
 *   node render.mjs --html story.html --limit 60      # 只渲前 60 帧，快速验片
 *
 * 并行：seek(t) 是纯函数，任意帧可独立渲染 → 开 N 个 tab 分块并行。
 *   --workers 6      指定并发 tab 数（默认 min(6, CPU/2)，1 = 退回串行）
 *
 * 退出码：0 成功 / 1 失败
 */

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile, readFile, stat, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
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
// --aspect 是 --width/--height 的快捷写法，两者同时给时以显式宽高为准
const WIDE_ASPECT = ['wide', '16:9', 'landscape', 'horizontal'].includes(
  String(args.aspect || '').toLowerCase());
const WIDTH = Number(args.width || (WIDE_ASPECT ? 1920 : 1080));
const HEIGHT = Number(args.height || (WIDE_ASPECT ? 1080 : 1920));
const OUT = path.resolve(args.out || './out/video.mp4');
// 默认 JPEG：1080p PNG 单帧 1.5–3MB，base64 过 CDP 是串行渲染的主要成本。
// q95 是深色细线场景的下限，再低会在 1px 结构线和低亮渐变上出色带。
const FORMAT = String(args.format || 'jpeg').toLowerCase(); // jpeg | png
const JPEG = FORMAT === 'jpeg';
const EXT = JPEG ? 'jpg' : 'png';
const QUALITY = Number(args.quality || 95);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const CPU_N = cpus().length;
// 每 worker 默认分到一半物理核：再多会让合成线程互相抢 CPU，settle 时间内截到残帧
const WORKERS = Math.max(1, Math.min(12,
  args.workers === undefined ? Math.min(6, Math.max(1, Math.floor(CPU_N / 2))) : Number(args.workers)));
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
  // WorkBuddy 只授权 Edge 自动化：Edge 永远优先，Chrome 仅作最后回退（会打警告）
  const EDGE = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/microsoft-edge',
  ];
  const CHROME = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  for (const c of EDGE) if (c && existsSync(c)) return c;
  for (const c of CHROME) if (c && existsSync(c)) {
    console.error('[render] 警告：没找到 Edge，回退到 Chrome。本机渲染应当使用 Edge（WorkBuddy 只授权了 Edge 自动化）。');
    return c;
  }
  fail('找不到 Edge（应当优先使用已授权的 Microsoft Edge）。请用 --browser <路径> 指定 Edge 的 msedge.exe');
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
  // 复用 --frames-dir 时，上一次的 profile 还在。Edge 看到同名 profile 会认为已有实例在跑，
  // 新进程直接退出、不监听调试端口 → 表现为「连不上端口，fetch failed」，重试也救不回来。
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(userDataDir, { recursive: true });

  // 一个 worker 一个浏览器进程。共用同一个浏览器会让所有 tab 的合成挤在同一个 GPU 进程里排队，
  // 并发度实测接近 1（6 tab 194ms/帧 vs 单 tab 131ms/帧），是纯负优化。
  const makeArgs = (udd) => [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${udd}`,
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
    '--disable-partial-raster',
    '--run-all-compositor-stages-before-draw',
    '--disable-new-content-rendering-timeout',
    'about:blank',
  ];

  const browsers = [];   // { proc, cdp, udd }
  const launchBrowser = async (wid) => {
    const udd = path.join(workDir, `profile-${wid}`);
    await rm(udd, { recursive: true, force: true }).catch(() => {});
    await mkdir(udd, { recursive: true });

    const proc = spawn(browser, makeArgs(udd), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let errBuf = '';
    proc.stderr.on('data', (d) => { errBuf += d.toString(); });
    const entry = { proc, cdp: null };
    browsers.push(entry);

    const port = await waitForPort(path.join(udd, 'DevToolsActivePort')).catch((e) => {
      throw new Error(`${e.message}\nBrowser[w${wid}] stderr:\n${errBuf.slice(-1200)}`);
    });

    // DevToolsActivePort 写入 ≠ HTTP 服务已监听，紧接着 fetch 会偶发 ECONNREFUSED。
    // 必须重试，否则表现为 "fetch failed" 且无法定位（换机器/负载高时更容易命中）。
    let version = null, lastErr = null;
    for (let i = 0; i < 40; i++) {
      try {
        version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        break;
      } catch (e) {
        lastErr = e;
        await sleep(120);
      }
    }
    if (!version) throw new Error(`连不上调试端口 ${port}（w${wid}）：${lastErr?.message || ''}`);
    entry.cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    return entry;
  };

  try {

    const fileUrl = pathToFileURL(htmlPath).href;

    /**
     * 开一个独立的 tab 并把页面准备到可渲染状态。
     * 每个 tab 有独立 sessionId，共用一个 browser 级 WebSocket —— CDP 的 flatten 模式
     * 天然支持多 session 并发，所以 N 个 tab 的分帧请求彼此不排队。
     */
    async function openTab(cdp, tag) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
      }, sessionId);
      await cdp.send('Page.navigate', { url: fileUrl }, sessionId);

      // 关键：headless 同时挂多个 tab 时，只有「前台」那个的 requestAnimationFrame 会跑，
      // 其余的 rAF 被永久暂停 → seekExpr 里的双 rAF 永不 resolve → worker 静默挂死。
      // 这两句把 tab 从 hidden 拉成 active，并让它认为自己有焦点。
      await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => {});
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});

      const readyDeadline = Date.now() + 30000;
      while (Date.now() < readyDeadline) {
        const r = await cdp.send('Runtime.evaluate', {
          expression: 'window.__ready === true && typeof window.seek === "function"',
          returnByValue: true,
        }, sessionId).catch(() => ({ result: { value: false } }));
        if (r?.result?.value === true) return sessionId;
        await sleep(60);
      }
      const diag = await cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ready: window.__ready, seek: typeof window.seek, err: window.__error || null})',
        returnByValue: true,
      }, sessionId).catch(() => null);
      throw new Error(`页面未就绪（tab ${tag}）诊断：${diag?.result?.value}\n页面 console 错误请用 --keep-frames 检查 ${htmlPath}`);
    }

    log(`[render] 载入 ${fileUrl}`);
    // 同一个浏览器里挂多个 tab 时，所有合成挤在一个 GPU 进程里排队，并发度实测接近 1。
    // 所以一个 worker 一个独立进程：合成、光栅化、JPEG 编码各自独立。
    const first = await launchBrowser(0);
    let sessionId = await openTab(first.cdp, 'w0');

    // 5) 读取时长
    let duration = args.duration ? Number(args.duration) : null;
    if (!duration) {
      const r = await first.cdp.send('Runtime.evaluate', {
        expression: 'Number(window.__duration) || 0', returnByValue: true,
      }, sessionId);
      duration = Number(r?.result?.value) || 0;
    }
    if (!duration || duration <= 0) fail('无法确定时长：页面未设置 window.__duration，也未传 --duration');

    let totalFrames = Math.round(duration * FPS);
    if (LIMIT < totalFrames) totalFrames = LIMIT;
    const step = Number(args.step || 1); // 抽帧调试
    const captureCount = Math.ceil(totalFrames / step);

    // 每 worker 至少 12 帧才划算：开 tab + 载页 + 等字体要 0.6–1.5s，分太碎反而更慢
    const MIN_PER_WORKER = 12;
    const workers = Math.max(1, Math.min(WORKERS, Math.ceil(captureCount / MIN_PER_WORKER)));
    log(`[render] ${WIDTH}x${HEIGHT} · ${FPS}fps · ${duration.toFixed(2)}s · ${captureCount} 帧`
      + ` · ${workers} 并发 · ${JPEG ? `jpeg q${QUALITY}` : 'png'}`);

    // 6) 分块并行截图
    //    两次 rAF 只保证样式算完，不保证这一帧已经**光栅化到屏幕上**。
    //    Chrome 偶尔会在图层仍在 raster 时把整帧截成低分辨率平铺（画面像被缩小平铺 8 份），
    //    成片里就是"闪一下别的画面"。等足一个帧间隔再截，这一帧才算真的画完。
    const SETTLE_MS = Number(args.settle || 40);
    const seekExpr = (t) => `(async () => {
      window.seek(${t});
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise(r => setTimeout(r, ${SETTLE_MS}));
      return true;
    })()`;

    // 其余 worker：各自起一个浏览器进程 + 一个 tab，并行初始化
    const team = [{ ...first, sessionId }];
    if (workers > 1) {
      const rest = await Promise.all(Array.from({ length: workers - 1 }, async (_, i) => {
        const wid = i + 1;
        const w = await launchBrowser(wid);
        return { ...w, sessionId: await openTab(w.cdp, 'w' + wid) };
      }));
      team.push(...rest);
    }

    // 连续分块，不是轮询：同一 worker 内的帧在时间上相邻，
    // "突变帧体积明显小于邻帧"这条残帧判据才成立。
    const ranges = [];
    {
      const base = Math.floor(captureCount / workers);
      const rem = captureCount % workers;
      let cur = 0;
      for (let i = 0; i < workers; i++) {
        const len = base + (i < rem ? 1 : 0);
        if (len > 0) ranges.push({ from: cur, to: cur + len });
        cur += len;
      }
    }

    const t0 = Date.now();
    let doneCount = 0;
    let lastLog = 0;

    const workerLoop = async (conn, sid, range) => {
      const sizes = [];   // 本 worker 近 30 帧体积，用于识别"被压扁的低分辨率残帧"
      const grab = () => conn.send('Page.captureScreenshot', {
        format: JPEG ? 'jpeg' : 'png',
        ...(JPEG ? { quality: QUALITY } : {}),
        fromSurface: true,
        captureBeyondViewport: false,
      }, sid);

      for (let k = range.from; k < range.to; k++) {
        const i = k * step;
        const t = totalFrames === 1 ? 0 : i / (totalFrames - 1);
        await conn.send('Runtime.evaluate', {
          expression: seekExpr(t.toFixed(6)), awaitPromise: true, returnByValue: true,
        }, sid);

        let shot = await grab();
        // 兜底：残帧（整屏变成放大的低分辨率色块）体积会明显小于邻帧 → 多等一帧重截
        if (sizes.length >= 5) {
          const med = [...sizes].sort((a, b) => a - b)[Math.floor(sizes.length / 2)];
          if (shot.data.length < med * 0.55) {
            await sleep(90);
            shot = await grab();
          }
        }
        sizes.push(shot.data.length);
        if (sizes.length > 30) sizes.shift();

        await writeFile(path.join(framesDir, `f_${String(k + 1).padStart(5, '0')}.${EXT}`),
          Buffer.from(shot.data, 'base64'));

        doneCount++;
        if (!QUIET && Date.now() - lastLog > 900) {
          lastLog = Date.now();
          const elapsed = (Date.now() - t0) / 1000;
          const eta = (elapsed / Math.max(1, doneCount)) * (captureCount - doneCount);
          log(`[render] 帧 ${doneCount}/${captureCount}  ${(100 * doneCount / captureCount).toFixed(0)}%`
            + `  已用 ${elapsed.toFixed(0)}s  预计剩余 ${eta.toFixed(0)}s`);
        }
      }
    };

    await Promise.all(ranges.map((r, i) => workerLoop(team[i].cdp, team[i].sessionId, r)));

    // 7) 帧完整性校验。并行带来的新失败模式是"某 tab 崩了 → 缺帧"：
    //    ffmpeg 不会报错，只会把成片悄悄缩短几帧。必须在这里拦住。
    {
      const miss = [], tiny = [];
      let bytes = 0;
      for (let k = 1; k <= captureCount; k++) {
        const f = path.join(framesDir, `f_${String(k).padStart(5, '0')}.${EXT}`);
        try {
          const s = await stat(f);
          bytes += s.size;
          if (s.size < 2048) tiny.push(k);
        } catch { miss.push(k); }
      }
      if (miss.length) {
        throw new Error(`帧缺失 ${miss.length}/${captureCount}（索引 ${miss.slice(0, 12).join(',')}`
          + `${miss.length > 12 ? ' …' : ''}）\n并行时某个 tab 可能崩了：先 --workers 1 复现；`
          + `仍缺则用 --keep-frames 检查帧目录`);
      }
      if (tiny.length) {
        throw new Error(`有 ${tiny.length} 帧体积 < 2KB（疑似空白/黑帧）：索引 ${tiny.slice(0, 12).join(',')}\n`
          + `把 --settle 提到 70 重渲；JPEG 下仍出现则改用 --format png`);
      }
      log(`[render] 帧校验通过 ${captureCount}/${captureCount} · 平均 ${(bytes / captureCount / 1024).toFixed(0)}KB/帧`);
    }

    const capSec = (Date.now() - t0) / 1000;
    log(`[render] 截图完成 ${capSec.toFixed(1)}s`
      + `（${(capSec / captureCount * 1000).toFixed(0)}ms/帧 · ${workers} 并发）`);

    // 8) FFmpeg 合成
    const pattern = path.join(framesDir, `f_%05d.${EXT}`);
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

    // 9) 清理
    for (const w of browsers) {
      await w.cdp?.send('Browser.close').catch(() => {});
      w.cdp?.close();
    }
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
      frameCheck: 'ok',
      workers,
      format: JPEG ? `jpeg-q${QUALITY}` : 'png',
      captureSeconds: +capSec.toFixed(1),
      msPerFrame: +(capSec / captureCount * 1000).toFixed(0),
      totalSeconds: +total,
      bgm: hasBgm ? BGM : BGM_SYNTH ? 'synth' : 'silent',
    }, null, 2));
  } catch (e) {
    for (const w of browsers) {
      try { w.cdp?.close(); } catch { /* noop */ }
      try { await run('taskkill', ['/PID', String(w.proc.pid), '/T', '/F']).catch(() => {}); } catch { /* noop */ }
      try { w.proc.kill('SIGKILL'); } catch { /* noop */ }
    }
    fail(e.message);
  }

  // 兜底：确保所有浏览器进程退出
  for (const w of browsers) { try { w.proc.kill('SIGKILL'); } catch { /* noop */ } }
})();
