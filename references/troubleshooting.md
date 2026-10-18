# 排错与容错

## 一、失控模式速查

| 症状 | 真实原因 | 处置 |
|---|---|---|
| 改了文案但画面没变 | 只改了 story.json，没重跑 `build` | 每次改完必须 `build` → `qa` → `render` 全链路 |
| 越改越糟，原本好的屏也坏了 | 动了 `template.html` 的 CSS | 模板是标定的。回滚模板，只改 story.json |
| 字号来回调，永远差一点 | 用缩字号解决溢出 | 溢出的根因是**字数**，删字不是缩字 |
| 标题看着像黑体，没有笔锋 | `font-weight` 与 `@font-face` 不匹配 | 楷体只能 `500`，写 400 会静默回退 |
| 首帧字形不对，后面正常 | 没等 `document.fonts.load()` | 必须显式 load 三个字重再 `seek(0)` |
| 场景切换处闪黑 | 淡入区间过长（>6% 场景时长） | `vis` 的淡入改成 `prog(p,0,0.055)` |
| 片子中间某 1–2 帧闪出别的画面（拖回去逐帧才看得见） | 截图时图层还在光栅化，Chrome 返回了低分辨率平铺帧 | 已修：`render.mjs` 每帧等 `--settle`（默认 40ms）+ 体积异常自动重截；`qa --video` 的 `flash-frame` 会卡这条 |
| 图形压住正文 | `fx` 的 y 基准写高了 | 图形基线 `H*0.745`、顶部 `H*0.535`，不要低于这条 |
| 正文被推出屏幕底部 | 用 flex `margin-top:auto` 撑开 | 模板已改绝对定位，勿回退 |
| 渲染卡在「页面未就绪」 | 页面 JS 报错，`window.__ready` 没置位 | 抓 `window.__error`，多半是 story.json 字段缺失 |
| `qa` 报 font-missing | `assets/fonts/` 缺失或路径不对 | `build` 会把字体路径改成绝对 `file://`，别手改 html |
| ffmpeg 报错 | PATH 里没有 ffmpeg | 装 ffmpeg，或用 `--ffmpeg <路径>` |
| 视频没声音 | 用了 `--bgm none`，或 `assets/bgm/vibe.mp3` 被删 | 默认应自带神曲；确认文件在，或换 `--bgm 音乐.mp3` |
| 成片比预期短很多 | 配乐比片子短且没循环 | 已用 `-stream_loop -1` 修好；若仍短，检查是否手动改过 ffmpeg 参数 |
| 卡点对不上 / 切屏踩空 | `assets/beats.json` 是旧歌的 | 换歌后必须重跑 `node scripts/beat.mjs --audio 新歌 --out assets/beats.json` |
| 卡点后某屏变得太短或太长 | 位移把时长顶到了 4–9s 边界 | 调 story 里该屏的 `dur` 目标值，让 ±0.5s 有腾挪空间 |
| 输出 `bpm: null` | 配乐太安静或纯人声，没检测到击打 | 用鼓点清楚的曲子；或 `build --no-beat` 放弃卡点 |
| **`window.__ready === true`、`window.__error === null`，但成片全黑** | `window.seek` 被写成 `function(t){ seek(t) }`。顶层 `function seek(){}` 是全局对象的属性，这次赋值把它覆盖了，包装函数里的 `seek(t)` 解析到自己 → 无限递归 → 爆栈被内层 catch 吞掉，真正的 `seek` 一次都没跑 | 先把实现存成词法常量再包装：`const seekImpl = seek; window.seek = t => seekImpl(t);`，启动自检也调 `seekImpl(0)`。**只信 `__ready` 不看画面，必踩** |
| 标题被拦腰折成两截，和 `\n` 写的分行对不上 | 手动分行已用 `<span>` 包好，但容器还有 `max-width`，浏览器又按宽度折了一次 | 分行内层元素加 `white-space:nowrap`；宽度只由字号控制，不交给 `max-width` |
| 联系图里图形「没画出来」，单帧原图却正常 | 联系图缩到 440–480 宽，7px 的点只剩 1.6px，JPEG 压缩直接抹平 | 判定「图形缺失」前必须先看**单帧原图**；要批量看就按 50% 裁切看局部，不要用满屏缩略图下结论 |
| 字距/宽度算得刚好，实际却换行 | `letter-spacing` 不参与 `measureText` 和字数估算，每行累积 0.01em × 字数 | 按 em 宽度反推字号时留 3% 余量（`× 0.97`），别贴着容器宽算 |
| **`连不上浏览器调试端口 … fetch failed`，重试 40 次仍失败；进程列表里 msedge 一堆、headless 0 个** | 复用 `--frames-dir` 时上一轮的 `browser-profile` 还在。Edge 看到同名 profile 目录，判定「已有实例在跑」，新进程直接退出、根本不监听调试端口——所以再重试也没用，不是网络抖动 | 已内置：`render.mjs` 启动前先 `rm -rf <workDir>/browser-profile` 再 `mkdir`。手动兜底就是 `rm -rf frames` 重跑。**看到这个报错不要怀疑端口/防火墙，先看 profile** |

## 二、静默失败：不报错，但结果是错的

这一类最贵——`__ready === true`、控制台干净、退出码 0，画面却是错的。
共同处置方式只有一个：**在页面上给启动状态留一个可读出口**。

```js
// 启动块最后一行
document.documentElement.setAttribute('data-boot', msg);  // "OK | idx=0 n=13 cls=scene on dur=59.52"
```

抓取不用开浏览器，`--dump-dom` 一条命令就够：

```bash
msedge --headless=new --dump-dom file:///<绝对路径>/story.html | grep -oE 'data-(boot|err)="[^"]*"'
```

三条判据，任一不满足先别渲染（渲染一轮 20 分钟，试错成本极高）：

| 判据 | 期望 | 不符说明什么 |
|---|---|---|
| `data-boot` 以 `OK` 开头 | 启动块跑完 | 脚本在启动块**之前**就中止了（`data-err` 会给出行号和列号） |
| `cls` 里含 `on` | 第一屏已挂上 | `seek` 没真正执行 |
| `idx` 是数字不是 `undefined` | 屏定位成功 | 同上 |

**「启动块跑了」和「seek 真跑了」是两件事。** 被 catch 吞掉的异常会让前者为真、后者为假，
所以自检必须打印 `idx` 和 `cls`，只打印一个 `OK` 等于没打印。

同时挂一个顶层捕获器，把行号带出来：

```html
<script>window.addEventListener('error', e => {
  document.documentElement.setAttribute('data-err', e.message + ' | ' + e.lineno + ':' + e.colno);
}, true);</script>
```

## 三、三轮不过就降级

`qa` 连续 3 轮仍有错误 → 停止微调，按顺序降级：

1. **删场景**：7 屏砍到 5 屏，把最挤的两屏合并
2. **去图形**：删掉该屏的 `fx`，文字独占全屏
3. **减字数**：每个 `body` 只留 1 行，`title` 每行 ≤ 8 字

降级不丢人，40 秒能讲完一件事，好过 70 秒讲不清楚。

## 四、什么时候该停

| 情况 | 判据 |
|---|---|
| 收敛 | `qa` 0 错，密度 4%–30% |
| 该降级 | 同一屏连续 3 轮报同类错误 |
| 该上报 | 渲染 3 次失败，或单帧 > 1.5s（机器过载） |
| 该放弃 | 用户文案本身包含 > 12 个并列论点，先反问要不要拆成多集 |

## 五、容错设计（已内置，无需干预）

- **字体**：三份子集化文件内嵌，路径绝对化，不依赖系统安装
- **音频**：默认 `assets/bgm/vibe.mp3`，短则循环、末尾 1.2s 淡出；`--bgm none` 时自动补 `anullsrc` 静音轨
- **卡点**：`beats.json` 缺失时 build 只警告一次并跳过，不影响出片
- **浏览器**：Edge/Chrome 自动探测，找不到会明确报错
- **抽帧调试**：`--step 90` 保持时长不变，只降帧率
- **试片速判**：`--limit 90` 只渲前 3 秒

## 六、性能参考

| 场景 | 耗时 |
|---|---|
| 单帧截图 · 1080×1920 | 260–400ms（含 40ms 稳定等待） |
| 45s / 30fps 全量 · 竖屏 | 6–9 分钟 |
| **单帧截图 · 1920×1080** | **620–660ms** |
| **60s / 30fps 全量 · 横屏** | **19–20 分钟**（1786 帧） |
| 45s 抽帧（step 90） | 40 秒 |
| ffmpeg 编码 | 15–30 秒 |

机器同时跑其他重任务时，单帧可能涨到 1.2s，属于正常，不要中断。

**横屏的像素量是竖屏的 2.4 倍，单帧耗时也接近 2.4 倍**——60 秒横屏片跑满 20 分钟是正常值，
不是卡死。判断卡死看输出里的 `帧 n/N` 有没有在涨，不要看总时长。
