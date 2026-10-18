# vibe-knowledge-video-yashu

把一段文案做成抖音「vibe 知识大赏」风格的竖屏知识视频（1080×1920 MP4）。
零外部依赖：只用 Node 22 + 无头 Edge/Chrome + ffmpeg。

本目录同时是 WorkBuddy 技能运行目录和 git 仓库：
`~/.workbuddy/skills/vibe-knowledge-video-yashu/`。改完即生效，无需部署。

## 一条命令

```bash
cp story.example.json story.json          # 第一次用：复制样例
node scripts/run.mjs --story story.json --out out/final.mp4
```

依次完成：容量校验 → 卡点 → 排版体检 → 逐帧渲染 → 黑屏终检。任一步失败即停，并给出可执行的改法。

## 目录

```
SKILL.md                 技能说明（铁律 / 流水线 / 字段契约 / 自进化协议）
story.example.json       可直接改的样例（唯一的输入格式）
scripts/
  run.mjs                一键流水线
  build.mjs              容量校验 + 卡点 + 注入模板
  beat.mjs               分析配乐，产出击打点时间表
  qa.mjs                 几何体检 / 联系图 / 黑屏终检
  render.mjs             无头浏览器逐帧截图 + ffmpeg 合成
  learn.mjs              把一条经验写进 references/learnings.md
assets/
  template.html          1080×1920 分镜模板（唯一视觉来源）
  beats.json             击打点时间表（由 beat.mjs 生成）
  fonts/                 两款字体子集（OFL 1.1）
  bgm/vibe.mp3           配乐神曲，默认启用（3.7MB）
references/
  copywriting.md         文案改写规范
  design-system.md       画布 / 字体 / 字号 / 动效
  troubleshooting.md     排错与容错
  learnings.md           经验日志（自进化底稿）
```

## 两条硬约束

- **只用两款字体**：`LXGW WenKai GB`（楷，标题）+ `Noto Sans SC`（黑，正文）。
- **不看图调版式**：排版问题由 `qa.mjs` 用几何测量输出，单条视频 1k–3k token。

## 配乐

`assets/bgm/vibe.mp3` 随仓库分发，`render.mjs` 默认启用，`--bgm none` 关闭。
换歌后必须重算卡点：

```bash
node scripts/beat.mjs --audio assets/bgm/新歌.mp3 --out assets/beats.json
```

> 该曲目版权归原作者，本仓库仅供个人本地出片使用，请勿再分发或商用。

## 提交

```bash
node push.js "feat: 改了什么"     # add -A → commit → push → 打 tag
```

VS Code 里也可以按 `F5` 选「🚀 Push to GitHub」（配置在 `.vscode/launch.json`）。

## 自进化

这不是一个"写完就冻结"的技能。每次出片后，若出现能改变下次行为的新事实
（更优做法、文档与代码的错误），必须当场改进代码或文档，并用 `learn.mjs` 记一条。
规则写在 `references/learnings.md` 顶部，协议写在 `SKILL.md` 的「自进化协议」。

```bash
node scripts/learn.mjs list       # 最近 10 条经验
```

## 字体许可

`assets/fonts/` 下为两款 OFL 1.1 字体的子集，允许随作品分发：
Noto Sans SC（Google）、LXGW WenKai GB（LXGW）。商用前请自行复核许可证原文。
