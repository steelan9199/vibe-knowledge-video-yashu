# vibe-knowledge-video-yashu

把一段文案做成抖音「vibe 知识大赏」风格的竖屏知识视频（1080×1920 MP4）。
零外部依赖：Node 22 + 无头 Edge/Chrome + ffmpeg。

本目录同时是 WorkBuddy 技能运行目录和 git 仓库：
`~/.workbuddy/skills/vibe-knowledge-video-yashu/`。改完即生效，无需部署。
**完整用法见 [SKILL.md](SKILL.md)**，这里只讲仓库本身。

```bash
cp story.example.json story.json
node scripts/run.mjs --story story.json --out out/final.mp4   # 校验→卡点→体检→渲染→终检
node push.js "feat: 改了什么"                                  # 只推 main，自动打 tag
```

## 仓库约定

- 只有 `main` 一条分支 + 版本 tag，不用特性分支；`push.js` 拒绝在非 `main` 分支推送。
- 入库：脚本、模板、字体子集、配乐、击打点、文档。
- 不入库：`out/`、`*.log`、`demo*.mp4`、`story.json`（个人工作副本）。

## 目录

```
SKILL.md                技能说明：铁律 / 流水线 / 字段契约 / 自进化协议
story.example.json      输入样例（唯一输入格式）
push.js                 提交 + 推 main + 打 tag
scripts/                run · build · beat · qa · render · learn
assets/                 template.html · beats.json · fonts/ · bgm/vibe.mp3
references/             copywriting · design-system · troubleshooting · learnings
```

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
