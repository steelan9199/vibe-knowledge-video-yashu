# vibe-knowledge-video-yashu

把一段文案做成抖音「vibe 知识大赏」风格的知识视频。
默认竖屏 1080×1920，加 `--aspect wide` 出横屏 1920×1080。
零外部依赖：Node 22 + 无头 Edge/Chrome + ffmpeg。
渲染是并行的：`seek(t)` 是纯函数 → 6 个 tab 分连续块跑（默认 JPEG q95），60s 片子约 1 分钟。

本目录同时是 WorkBuddy 技能运行目录和 git 仓库：
`~/.workbuddy/skills/vibe-knowledge-video-yashu/`。改完即生效，无需部署。
**完整用法见 [SKILL.md](SKILL.md)**，这里只讲仓库本身。

```bash
cp story.example.json story.json
node scripts/run.mjs --story story.json --out out/final.mp4   # 校验→卡点→体检→渲染→终检
node scripts/run.mjs --story story.json --out out/wide.mp4 --aspect wide   # 横屏
node push.js "feat: 改了什么"                                  # 只推 main，自动打 tag
```

## 仓库约定

- 只有 `main` 一条分支 + 版本 tag，不用特性分支；`push.js` 拒绝在非 `main` 分支推送。
- 版本号在 `SKILL.md` frontmatter 的 `version`（`x.y.z`）。**每次改动先升版再 push**，见 SKILL.md §9。
- 入库：脚本、模板、字体子集、配乐、击打点、文档。
- 不入库：`out/`、`*.log`、`demo*.mp4`、`story.json`（个人工作副本）。

## 目录

```
SKILL.md                      技能说明：铁律 / 流水线 / 字段契约 / 自进化协议
story.example.json            竖屏输入样例（story 结构 A）
push.js                       提交 + 推 main + 打 tag
scripts/                      run · build · beat · qa · render · learn · selfcheck
assets/
  template.html               竖屏模板 1080×1920
  template-wide.html          横屏模板 1920×1080（版式 split/center/data/vert/formula）
  cover-template.html         合集封面模板 1080×1080
  covers/                     已出片的封面成品
  story.example-wide.json     横屏输入样例（story 结构 B，字段与竖屏不同）
  beats.json · fonts/ · bgm/vibe.mp3
references/                   copywriting · design-system · troubleshooting · learnings
```

**两套 story 结构不通用**：竖屏用 `type`（hook/quote/scene/stat/outro），横屏用
`layout` + `node`。选错结构 `build` 会直接报字段错，不会渲出半成品。

## 两条硬约束

- **只用两款字体**：`LXGW WenKai GB`（楷，标题）+ `Noto Sans SC`（黑，正文），OFL 1.1 子集内嵌。
- **不看图调版式**：排版问题由 `qa.mjs` 用几何测量输出，单条视频 1k–3k token。

## 配乐

`assets/bgm/vibe.mp3` 随仓库分发，`render.mjs` 默认启用，`--bgm none` 关闭。
换歌后必须重算卡点：

```bash
node scripts/beat.mjs --audio assets/bgm/新歌.mp3 --out assets/beats.json
```

> 曲目版权归原作者，本仓库仅供个人本地出片，请勿再分发或商用。
