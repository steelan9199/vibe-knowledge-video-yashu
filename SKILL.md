---
name: vibe-knowledge-video-yashu
description: 把一段文案做成抖音「vibe 知识大赏」风格的竖屏知识视频（1080x1920 MP4）。用户给出文案、观点或选题，输出可直接发布的知识短视频。触发词：vibe知识、知识大赏、知识视频、把这段文案做成视频、竖屏知识视频、生成知识短视频、文案转视频。
version: 1.6.4
---

# Vibe 知识视频生成器

## 0. 五条铁律

1. **不靠看图改稿。** 1080×1920 截图 ≈ 1.5k token/张。排版问题一律由 `qa.mjs` 用几何测量输出，模型只读几十行文字结论。
2. **先过校验再渲染。** `build.mjs` 在写文案阶段就拦截溢出；全片渲染 3–5 分钟，不要用它当调试器。
3. **一轮只改 story.json。** 改文案 → 重跑 build/qa，不碰模板、不碰脚本。
4. **做完一片必须自省一次。** 发现更优做法或代码/文档错误，**当场改掉并记一条**，不等用户开口。见 §9 自进化协议。**凡改了本仓库文件，就升一次 version 并 push**（§9 第五步）。
5. **小字必须看得清。** <48px 的文字一律 ≥9:1 对比度 + 500 字重（`qa.mjs` 的 `low-contrast` 卡这条）。大字号白给、小字糊掉，是这类片子最常见的翻车。

**单条视频的 token 成本**

| 环节 | 约耗 | 说明 |
|---|---|---|
| 改写文案 → story.json | 600–1200 | 唯一的大头，一次写对 |
| build + qa | 150–350 | 聚合后的违规清单 |
| 渲染 | ~30 | 一行 JSON |
| 联系图（可选） | ~1700 | 只在需要目检画面时 |
| **合计** | **1k–3k** | 不看图即可交付 |

省 token 的关键只有一条：**把"看"换成"量"**。

## 1. 流水线

```
用户文案
  ↓ ① 改写（模型，唯一耗 token 的环节）
story.json
  ↓ ② build.mjs   → 容量校验 + 注入 → out/story.html
  ↓ ③ qa.mjs      → 排版体检（0 错才继续）
  ↓ ④ render.mjs  → 逐帧截图 + ffmpeg → out/final.mp4
  ↓ ⑤ qa.mjs --video → 黑屏/静帧终检
```

②③ 是负反馈回路：**校验不过就回到 ①，只改被点名的那几行**。

## 2. 唯一的产出物：story.json

从 [story.example.json](story.example.json) 复制一份再改，不要从零手写字段。

```json
{
  "meta": { "series": "INFORMATION THEORY", "handle": "@你的账号", "startIndex": 1 },
  "scenes": [
    { "type": "hook",  "dur": 4.5, "kicker": "信息论 · 第一讲",
      "title": ["你刷到的每一条", "都是<em>猜不到</em>的"],
      "body": "信息量的大小，\n和你说了多少字无关。",
      "fx": { "type": "particles", "n": 70, "seed": 11 } },

    { "type": "quote", "dur": 6.5, "kicker": "SHANNON · 1948",
      "quote": "信息的多少，不取决于你\n说了什么，而取决于对方\n<em>猜不到</em>什么。",
      "cite": "《通信的数学理论》" },

    { "type": "scene", "dur": 7,
      "title": ["八个格子", "藏一个数字"],
      "body": "我心里想 1 到 8 的一个数。\n每问一次是非题，排除一半。",
      "fx": { "type": "grid", "cols": 4, "rows": 2, "cell": 168, "gap": 40, "highlight": 5 } },

    { "type": "stat", "dur": 6, "kicker": "ENTROPY",
      "stat": { "from": 0, "to": 3, "decimals": 0, "unit": "BITS" },
      "label": "八个等可能的答案，猜中它\n需要的信息量，正好 3 比特。" }
  ]
}
```

**字段规则**

| 字段 | 约束 |
|---|---|
| `type` | `hook`(开场钩子) / `quote`(引文) / `scene`(叙述) / `stat`(数字) / `outro`(收尾) |
| `dur` | 4–9 秒。按 5–6 字/秒朗读估算，别拍脑袋。**这是目标值**：build 会在 ±0.5s 内把它推到鼓点上 |
| `title` | 数组，**每项一行，最多 2 行，每行 ≤ 12 字**。`<em>…</em>` 高亮，每屏最多 1 处 |
| `body` | 用 `\n` 手动断行，最多 2 行，每行 ≤ 20 字。带图形时只能 1 行 |
| `quote` | 最多 3 行，每行 ≤ 12 字 |
| `label` | stat 的说明，最多 2 行，每行 ≤ 18 字 |
| `kicker` | 顶部小标，≤ 26 个字符宽度（中文 1、拉丁 0.55） |
| `fx.type` | `particles` 氛围粒子 / `grid` 可能性网格 / `curve` 曲线 / `flow` 回路图 / `bars` 分布。**grid / curve / flow 自带信息论题材的默认文案**（`log₂ 8 = 3`、"发生概率 p"、"推荐模型"…），换题材要么覆写：`fx.caption`(grid) · `fx.xLabel`/`fx.yLabel`/`fx.xTag`/`fx.yTag`(curve) · `fx.labels`(flow 四节点，传 `""` 可隐藏)，要么改用 `particles`/`bars`——画布上的字不报错，只会文不对题 |

**场景配比（45–70 秒，6–8 屏）**

```
hook → quote → scene → stat → scene → scene → outro
1      1        2-3             1-2              1
```

## 3. 命令

**首选：一条命令跑完**（校验 → 体检 → 渲染 → 终检，任一步失败即停并给出改法）

```bash
node scripts/run.mjs --story story.json --out out/final.mp4
```

默认就带上技能自带的**神曲**（`assets/bgm/vibe.mp3`）并自动卡点，不需要任何参数。

**分步执行**（只在需要单独定位问题时用）

```bash
node scripts/build.mjs  --story story.json --out out/story.html
node scripts/qa.mjs     --html out/story.html
node scripts/render.mjs --html out/story.html --out out/final.mp4 --quiet
```

常用参数：

| 参数 | 作用 |
|---|---|
| `--bgm none` | 不要配乐（纯静音轨） |
| `--bgm 别的歌.mp3` | 换配乐，**同时要重跑 `beat.mjs`** 重新算卡点 |
| `--no-beat` | 保留配乐但不卡点，用 story 里写的原始时长 |
| `--draft` | 2fps 试片，30 秒出结果，看节奏用 |
| `--settle 40` | 每帧截图前等待的毫秒数（默认 40）。**调小会闪帧**，机器过载时调大到 70 |
| `--sheet out/sheet.png` | 附带联系图（约 1.7k token） |

**需要目检风格时**加 `--sheet`，把全部场景拼成一张联系图，而不是逐屏截图（每张 1.5k token）：

```bash
node scripts/run.mjs --story story.json --sheet out/sheet.png
```

## 4. 配乐与卡点

配乐不是"加个背景音"，**切屏必须落在鼓点上**，否则再好的文案也显得业余。

> **配乐是固定的那首神曲，卡点已经测完并存成档案了 → `references/beat-map-vibe.md`**
>
> 关键数字：**112.91 BPM** · 一拍 **0.53142s** · 16 拍一圈 **8.503s** · 首拍 **0.059s** · 301 个拍点 / 19 个圈头。
> **不要重跑分析，不要自己用公式推拍点。**
> 排片时长取 8.5s 的 1/1、1/2、1/3、1/4，切点自然落圈头。
> 查具体时间点：`node scripts/beats-info.mjs --at 12.34`

```
assets/bgm/vibe.mp3   （神曲，160s）
        ↓ scripts/refine-beats.py   librosa DP + 抛物线插值（换歌才跑）
assets/beats.json     { bpm, period, phase, onsets[301], strong[19], audioMd5 }
        ↓ scripts/build.mjs         把每个切点推到最近的击打上（±0.5s 内）
story.json 的 dur    → 实际时长被微调，输出会打印"切点全部落在击打上 + 几处需微调"
        ↓ scripts/inject            同时把 onsets 注入 window.__BEATS__
        ↓ scripts/render.mjs        -stream_loop -1 铺满全片 + 结尾 1.2s 淡出
out/final.mp4
```

`beats.json` 带音频 MD5 指纹：mp3 被换过时 `build.mjs` 会打警告、`beats-info.mjs --check` 退出码 1，
不会拿旧卡点配新音频。

**卡点表的唯一来源是 `refine-beats.py`（librosa DP + 抛物线插值）。**

- `beat.mjs` 是纯 Node 兜底：找拍长和相位不找"能量峰"，输出 `ratio`（<1.25 判"无可用节拍"），
  **但它的包络按帧起始对齐，整表相位早 20–40ms，不能直接出片**。
- 换歌/换母带后先跑 `refine-beats.py`，看它打印的**峰位≈0ms、峰背比≥2.5** 再往下走。
- 指标口径与验收方法见 `references/beat-map-vibe.md` 第 3 节。

**每拍都要有视觉事件（`__BEATS__`）**

build 会把击打点注入模板，`#beatcv` 那一层按时间戳画：

- 中央冲击波（两圈，错开 55ms）
- 全屏边缘暖光闪
- 整屏 `scale` 顶一下（1.3%，85ms 衰减）
- 左侧拍格：每 4 拍一格，已过 / 当前 / 未到三态
- 左上拍号 1–4 + `LOOP NN`（每 `strongEvery` 拍一圈）

**这是让卡点可被肉眼验证的机制**：音乐每响一下，画面必动一下。没有这一层，"卡点准不准"只能靠感觉。

配乐相关参数只有三个：`--bgm none` / `--bgm 别的歌.mp3` / `--no-beat`，其余见 §3。

**换歌两步**

```bash
cp 新歌.mp3 assets/bgm/
uv venv --python 3.12 .venv && uv pip install --python .venv librosa soundfile   # 只需一次
.venv/Scripts/python.exe scripts/refine-beats.py --audio assets/bgm/新歌.mp3 --out assets/beats.json
```

跑完看它打印的**峰位≈0ms、峰背比≥2.5**。达不到就别硬卡：这条音频没有可用节拍，
改成"每屏落在整秒"，或用 `scripts/make-drum-track.mjs` 造一条鼓点真值已知的基准轨，
用它做基准，而不是猜。确认可用后把 BPM、循环长度、圈头表更新进
`references/beat-map-vibe.md`，下次就又能直接查表。

**默认配乐 `vibe.mp3` 的身份**：容器里带 `comment: vid:...`、`major_brand: isom`，
是**从抖音视频抽出来的音轨**，混响极重，`ratio` 只有 1.46——但节拍是真实的。
不要因为它"听起来糊"就断定没有鼓：判断有没有鼓**至少放大到 2 秒看频谱**，
整段压成一张波形图会把瞬态糊成噪声墙。


## 5. qa 不通过时怎么改

qa 的输出是**聚合后**的，同类问题一行，直接照做：

| 报错类型 | 含义 | 唯一正确的改法 |
|---|---|---|
| `safe-bottom` | 文字压进底部文案区 | 该屏减 1 行，或把最后一句拆到下一屏 |
| `safe-right` | 越过右侧按钮区 | 减少该行字数 |
| `overlap` | 两个元素交叠 | 删元素，不要只缩字号 |
| `font-small` | 字太小（<56px 标题 / <34px 正文） | 减字，不要靠缩字号硬塞 |
| `low-contrast` | 小字对比度 < 9:1（<48px）或 < 4.5:1（大字） | 提亮 `--ink-2`/`--ink-dim`，或把这档字重改成 500。**不要加描边/阴影**，压缩会变噪点 |
| `fx-overlap-text` | 图形压住正文 | 正文减 1 行 |
| `fx-intrudes` | 图形侵入底部 | 该屏去掉 `fx` |
| `black-frame` | 有黑屏 | 检查该屏 `dur` 是否 ≥ 4s |
| `flash-frame` | 成片里 1–2 帧闪出别的画面 | 不动 story：`render.mjs` 每帧已等 `--settle`（默认 40ms）并自动重截体积异常帧；机器过载时把 `--settle 70` 再渲一遍 |
| 画面全黑 / 元素不出现，但**没有任何报错** | 异常被 catch 吞掉，`__ready` 仍为 true | 见 `troubleshooting.md` §2「静默失败」。渲染前先跑一次 `msedge --headless=new --dump-dom file:///…/story.html \| grep -oE 'data-(boot\|err)="[^"]*"'`，`data-boot` 必须是 `OK` 且带 `idx=<数字>`、`cls=… on` |

**不要**为了过检去改模板 CSS —— 模板是标定过的，改它会让所有片子一起坏。

## 6. 文案改写规范（质量关键）

详见 `references/copywriting.md`。三条底线：

1. **一屏一个主张。** 塞两件事就拆屏。
2. **钩子在前 3 秒。** 用反常识断言或数字落差，不要自我介绍。
3. **结尾给动作。** 一句可执行的话，不要"让我们一起"。

## 7. 视觉与工程

- 设计系统、字体白名单、安全区：`references/design-system.md`
- 排错与容错：`references/troubleshooting.md`

字体只有两款，**不得引入第三种**：`LXGW WenKai GB`（楷，标题/引文/大数字）、`Noto Sans SC`（黑，正文/标签）。已子集化内嵌在 `assets/fonts/`。

**文件职责**（改动前先认位置，别改错地方）

目录：`scripts/` 全部可执行脚本 · `assets/` 模板、字体、配乐 · `references/` 文案与视觉规范 · 根目录只有 `SKILL.md`、`story.example.json`、`push.js`（一键提交推送）。

| 文件 | 作用 | 什么时候动 |
|---|---|---|
| `scripts/run.mjs` | 一键流水线，串起 build→qa→render→终检 | 基本不动 |
| `scripts/build.mjs` | 容量校验 + 卡点 + 把 story 注入模板 | 只改文案时不动 |
| `scripts/refine-beats.py` | **卡点表唯一来源**：librosa DP 定周期相位 + 抛物线插值吸附，峰位 0ms | 换歌 / 换母带 / 重测时 |
| `scripts/beat.mjs` | 纯 Node 零依赖兜底：周期×相位拟合，相位早 20–40ms | 没有 Python 环境时临时用，不作最终表 |
| `scripts/beats-info.mjs` | 读已缓存的卡点表：概要 / `--at` 查拍 / `--snap` 对齐 / `--check` 指纹 | 排片期随时可用，不耗 CPU |
| `scripts/verify-beats.mjs` | 独立校验节拍表：三频段分离 + 网格拟合 + 鼓组证据 | 怀疑卡点不准 / 换新配乐时先跑它 |
| `scripts/make-drum-track.mjs` | 合成"鼓点真值已知"的基准音轨（96BPM） | 配乐没有可用节拍时 |
| `scripts/qa.mjs` | 几何体检 / 联系图 / 黑屏终检 | 判定阈值不合理时才动 |
| `scripts/render.mjs` | 无头浏览器逐帧截图 + ffmpeg 合成 | 改分辨率/帧率/音轨时 |
| `scripts/learn.mjs` | 写经验日志（自进化用） | 每次有可复用发现时 |
| `scripts/selfcheck.mjs` | 自检：语法 / 文档引用 / 规格数字 / 日志格式 / 回归 | 每次改完代码或文档后 |
| `assets/template.html` | 1080×1920 分镜模板（唯一视觉来源） | 只有换整片风格才动 |
| `assets/fonts/` | 三份子集化字体 | 不要动 |
| `assets/bgm/vibe.mp3` | 配乐神曲，默认启用 | 换歌时替换 |
| `assets/beats.json` | 卡点真值 + 音频指纹，卡点依据 | 由 `refine-beats.py` 生成，不手改 |
| `references/beat-map-vibe.md` | **曲目卡点档案**：BPM / 拍点表 / 圈头表 / 时长换算 / 禁忌 | 换歌或重测后同步更新 |
| `references/learnings.md` | 经验日志，沉淀还没变成规则的东西 | 随 `learn.mjs` 自动写 |
| `story.example.json` | 可直接改的样例 | 参考用 |

**浏览器规则（硬性）**

WorkBuddy 已经为该环境授权 **Edge 浏览器自动化**（设置 → 模型/助手 → 「让 WorkBuddy 控制浏览器」→ WorkBuddy Edge 扩展程序）。

- **一律用 Microsoft Edge，不要用 Chrome。** 本机的 Chrome 与 WorkBuddy 的自动化授权无关，混用会出现"能连上、但截不出帧"的静默失败。
- `render.mjs` 的 `findBrowser()` 按 **Edge → Chrome** 顺序探测，选到 Chrome 时会往 stderr 打警告。渲染日志第一行 `[render] Browser: …` 就是实际使用的浏览器，出片前先看这一行是不是 `msedge.exe`。
- 要显式指定：`--browser "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"`。
- **不要**为了跑渲染去装 Chrome、改 PATH、或把 `--browser` 指向 Chrome——授权的浏览器只有一个。

**为什么不做"正经分层架构"**

参考过后端分层那套（Controller / Service / Repository / Domain）。结论是**不照搬**：
那是给"多人协作、长周期、要频繁换数据库"的后端准备的，本技能一共 5 个脚本、1 个模板，
套四层只会多出一堆只做转发的空壳文件——正是那位作者自己警告的"过度设计"。

但那条原则里有一条对本技能是真痛点：**每层只做自己的事，且数据结构不越界**。所以实际只落了两条：

1. **契约只有两个**：`story.json`（输入）和 `assets/beats.json`（音乐）。中间产物 `out/story.html` 可随时重建，不进版本管理。
2. **规格只有一个事实源**：安全区、字号这些数字写在模板的 CSS 变量里，`qa.mjs` 运行时从页面读回来，不再自己存一份——否则改模板忘改 qa 就会"体检通过但其实压字"。

脚本之间只通过文件通信，不互相 import。这样任何一步都能单独重跑，坏哪步查哪步。

## 8. 交付

出片后把 `out/final.mp4` 交给用户，附一行字数/时长摘要。**不要**贴帧图，除非用户主动要求看画面。

## 9. 自进化协议（每次出片后执行，不必等用户要求）

这个技能是活的。**每交付一条片子，走一遍下面五步，1 分钟内完成。前四步是「改」，没有新事实时只花 5 秒。**

### 第一步：判断有没有新事实

只认三类，其余一律跳过（避免把日志写成日记）：

| 触发 | 例子 |
|---|---|
| **更优做法** | 发现某种分镜配比完播更好；某种文案结构更抓人 |
| **代码/文档错误** | 参数说明与实现对不上；判据写错了；某条报错根本没触发过 |
| **静默失败** | 现象与预期不符，但没有任何报错（最危险的一类） |

"这条片子挺好看" 不是新事实。"粒子层被误判成压字" 是。

### 第二步：当下就改，不要只记

- 是**代码**问题 → 改脚本/模板，然后重跑 `build` + `qa` 确认旧样例仍 0 错（回归）。
- 是**文档**问题 → 改 `SKILL.md` / `references/*.md`，让文档重新等于事实。
- 是**新方法** → 落成脚本参数或模板能力，写进 §5 或 `design-system.md`，不要只写在日志里。

**只记不改等于没沉淀。** 日志里每一条的"改动"栏必须是具体文件名 + 改法。

**文档只写"现在正确的事实"。** 被推翻的结论、失败尝试、版本沿革、"以前测成 X 后来改成 Y"
一律**直接删掉**（git log 里有的是），不要留在 SKILL.md / references 里占篇幅——它们会让下一个
读文档的人把错的当对的。唯一例外：**如果重犯这个错会导致静默、难发现、返工大的后果**，
就留**一句**"这样做会错"的操作警告，不带数字对比、不带历史（例：`beat.mjs` 的相位早 20–40ms）。
删错数据和删错结论要同步做：既然结论错了，`assets/` 里对应的错数据文件也一起删，
否则它迟早被当成基准。

### 第三步：记一条，必要时升级

```bash
node scripts/learn.mjs add \
  --symptom "一句话现象" \
  --cause "根因" \
  --fix "改了哪个文件、怎么改" \
  --check "怎么验证改对了（可执行）"
```

- 同一个问题**第二次**出现 → 升级：写进 §0 铁律或 `troubleshooting.md` 表格，**然后删掉日志条目**（日志只放还没变成规则的东西）。
- 日志上限 40 条，`learn.mjs` 自动淘汰最旧的。写满说明该合并成规则了。

### 第四步：自检，通过再走

改完代码/文档，先让机器确认"文档说的和代码做的一致"：

```bash
node scripts/selfcheck.mjs --regress
```

它查七件事：脚本能否解析 · 文档引用的文件是否存在 · 安全区数字模板与文档是否一致 ·
日志格式与条数 · 样例是否合法 · `version` 是否存在且为 `x.y.z` · 旧样例 build+qa 是否仍全过。
通过只要一行 `[check] 通过（v1.3.0 · …）`，前缀就是当前版本号。

**不通过就不提交。** 这一步是在拦"改完文档忘了改代码"这类不会报错的漂移。

### 第五步：升版本号 → 提交推送

**只要有改动落地，就先升版本号，再 push。** 版本号是 `SKILL.md` frontmatter 的 `version` 字段（frontmatter 第二行，紧跟 `description`），语义化三段 `MAJOR.MINOR.PATCH`：

| 改了什么 | 升哪一段 | 例 |
|---|---|---|
| 修错别字、改阈值、补文档、加日志条目 | PATCH | 1.2.3 → 1.2.4 |
| 加能力（新分镜类型、新参数、新脚本、新规则） | MINOR | 1.2.3 → 1.3.0 |
| 破坏兼容（story.json 字段改名/删除、模板整体重写） | MAJOR | 1.2.3 → 2.0.0 |

改完 `version` 一行就够，`selfcheck.mjs` 会校验格式并打印当前版本。然后一条命令提交并推送：

```bash
node push.js "learn: 一句话说明改了什么"   # 只推 main，自动打时间戳 tag
```

不传消息则用时间戳。**顺序不能反**：先改 version 再 push，否则推出去的提交里版本号是旧的。忘记提交 = 改动只活在本地，换机器就丢；忘记升版 = 出问题时没法定位是哪一版改坏的。
