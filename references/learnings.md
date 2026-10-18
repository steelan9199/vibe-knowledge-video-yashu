# 经验日志（自进化底稿）

这个文件不是文档，是技能的**记忆**。每次做完片子，若有能改变下次行为的新事实，就在这里加一条。

## 沉淀规则（写在最前面，因为它决定这个文件有没有用）

1. **只写"能改变下次行为"的事。** 「感觉更好看」不写；「楷体 400 字重会静默回退成黑体」必须写。
2. **写完必须落成改动。** 要么改了代码，要么改了 SKILL.md 里的规则。只记不改 = 没沉淀，等于没写。
3. **同一问题出现第二次，就不再留在日志里。** 把它升级成 SKILL.md 的铁律或 `troubleshooting.md` 的表格行，然后删掉日志条目——日志只放"还没变成规则的东西"。
4. **上限 40 条**，`learn.mjs add` 会自动保留最近 40 条。超出说明该合并成规则了。
5. **开始时不要读这个文件。** 只在遇到"这问题好像见过"时 `grep` 它，或者跑 `node scripts/learn.mjs --list`。

## 记录格式

```
### YYYY-MM-DD · 一句话现象
- 现象：
- 根因：
- 改动：文件 + 具体改法
- 判据：怎么确定改对了（可执行的检查）
```

---

### 2026-10-18 · __ready 为 true、__error 为 null，但整片全黑
- 现象：__ready 为 true、__error 为 null，但整片全黑
- 根因：window.seek 包装函数与同名函数声明同名，赋值后包装函数调用自己形成无限递归，爆栈被内层 catch 吞掉，真正的 seek 一次都没执行
- 改动：references/troubleshooting.md 新增§2静默失败：先存 seekImpl 再包装；自检必须打印 idx 与 cls（只打印 OK 等于没打印）；SKILL.md §5 加入口
- 判据：dump-dom 抓到 data-boot="OK | idx=0 … cls=scene … on"

### 2026-10-18 · 渲染偶发直接失败，只报 fetch failed，无其他信息
- 现象：渲染偶发直接失败，只报 fetch failed，无其他信息
- 根因：DevToolsActivePort 文件写入时 HTTP 调试服务还没开始监听；waitForPort 之后立刻 fetch /json/version 会 ECONNREFUSED，且原实现没有重试
- 改动：scripts/render.mjs：/json/version 请求改为最多 40 次重试、间隔 120ms，失败时报出端口号与最后错误
- 判据：连续跑 node scripts/render.mjs --html out/story.html --limit 3 三次均成功

### 2026-10-18 · 新写的 flash-frame 检测对合成闪帧片判「通过」，等于完全失效
- 现象：新写的 flash-frame 检测对合成闪帧片判「通过」，等于完全失效
- 根因：两处坑：① signalstats 把近零值写成 8.68e-05，正则 [\d.]+ 截成 8.68 制造假尖峰；② 闪帧的帧差特征是 H,H 或 H,L,H（两处突变夹住残帧），原判据写成「连续 ≥2 帧高」,对 H,L,H 和 H,H,H 全部漏判
- 改动：scripts/qa.mjs：正则吃科学计数法；判据改成「被两处突变夹住且前后平静」的块扫描（len≥2，或 H+1帧平静+H）
- 判据：用 ffmpeg concat 合成 A+2帧B+A / A+1帧B+1帧C+A 两条测试片，qa --video-only 必须分别报错；正式片必须通过

### 2026-10-18 · 成片在 5.3s 处闪了 2 帧别的画面（整屏变成缩小平铺的同一画面），肉眼只有逐帧才看得见
- 现象：成片在 5.3s 处闪了 2 帧别的画面（整屏变成缩小平铺的同一画面），肉眼只有逐帧才看得见
- 根因：render.mjs seek 后只等两次 rAF 就截图，此时图层可能还在光栅化，Chrome 返回低分辨率平铺的残帧；qa --video 只查黑屏，不查帧间突变
- 改动：scripts/render.mjs：每帧加 --settle 40ms 稳定等待 + PNG 体积低于邻帧中位数 55% 时自动重截 + Chrome 加 --disable-partial-raster；scripts/qa.mjs 新增 flash-frame（tblend 帧差，连续≥2 帧突变即判闪帧）
- 判据：node scripts/qa.mjs --video-only --video out/final.mp4（修前必须在 5.30s 报错，修后 0 错）

### 2026-10-18 · 成片大数字清楚，但 BPM 单位与说明文字在手机上糊成一片，用户看不清
- 现象：成片大数字清楚，但 BPM 单位与说明文字在手机上糊成一片，用户看不清
- 根因：次要文字用了 #B4AC9C/#6F695C（后者只有 3.6:1）+ 300 字重，深底细笔画过一遍视频压缩就没了；qa 只量几何，从不量对比度
- 改动：assets/template.html：--ink-2→#E2DCCE、--ink-dim→#C9C2B2、小字统一 500 字重；scripts/qa.mjs 新增 low-contrast（<48px 要 9:1，大字 4.5:1）；design-system.md 写判据；SKILL.md 加第五条铁律
- 判据：node scripts/qa.mjs --html out/story.html（应 0 错，且不再有 low-contrast）

### 2026-10-18 · stat 屏每次都被 qa 判 too-sparse（文字覆盖 2%），但画面正常
- 现象：stat 屏每次都被 qa 判 too-sparse（文字覆盖 2%），但画面正常
- 根因：密度判据只看文字块面积，stat 的主体是 300px 大数字，面积占比天然极低
- 改动：scripts/qa.mjs：too-sparse 对 sc.type === 'stat' 豁免
- 判据：node scripts/selfcheck.mjs --regress（样例含 stat 屏，应 0 警）

### 2026-10-18 · 非信息论题材用 grid/curve/flow，画面上冒出 log₂ 8=3、发生概率 p、推荐模型等无关文字
- 现象：非信息论题材用 grid/curve/flow，画面上冒出 log₂ 8=3、发生概率 p、推荐模型等无关文字
- 根因：模板把坐标轴/节点/说明文案写死在画布绘制代码里，build 与 qa 都不检查画布文字
- 改动：assets/template.html：grid 加 cfg.caption、curve 加 xLabel/yLabel/xTag/yTag、flow 加 labels 覆写，默认值保持原样；SKILL.md §2 fx 行写明约束
- 判据：node scripts/build.mjs --story story.example.json --out out/x.html && node scripts/qa.mjs --html out/x.html

### 2026-10-18 · 文档与代码漂移无任何报错
- 现象：文档与代码漂移无任何报错
- 根因：SKILL.md 写着 scripts/xxx 或安全区数字，代码改了文档没改，读的人照旧用法执行
- 改动：新增 scripts/selfcheck.mjs：校验脚本语法/文档引用/模板与文档数字/日志格式/样例/回归；run.mjs 结尾打印协议触发提示
- 判据：node scripts/selfcheck.mjs --regress 输出 [check] 通过

### 2026-10-18 · 配乐比成片短，成片被截断
- 现象：给 3 秒音乐，成片只有 3 秒，后面分镜全丢，且不报错
- 根因：`-shortest` 按最短流截断，配乐没循环
- 改动：`render.mjs` 改为 `-stream_loop -1 -i bgm`，末尾加 `afade` 1.2s
- 判据：`ffprobe` 时长 == story 总时长（3s 音乐配 45.5s 片仍出 45.5s）

### 2026-10-18 · 找不到音乐文件的警告被 --quiet 吞掉
- 现象：配乐路径写错，成片静音，但日志干净得像成功
- 根因：警告走 `log()`，而 `run.mjs` 调用时带 `--quiet`
- 改动：`render.mjs` 该警告改 `console.error`；完成摘要增加 `音轨 bgm/silent/synth` 字段
- 判据：错误路径下 stderr 能看到 `警告：找不到音乐`

### 2026-10-18 · 安全区数字在模板与 qa 各存一份
- 现象：改模板安全区，qa 仍按旧值判定，出现"体检通过但压字"
- 根因：`96/172/360` 两处硬编码，属规格分散
- 改动：`qa.mjs` 运行时从模板 CSS 变量读回 `--pad-x/--safe-top/--safe-bottom`
- 判据：改模板变量后 qa 报错数值跟着变

### 2026-10-18 · 楷体写 font-weight:400 静默回退成黑体
- 现象：标题看着没有笔锋，像黑体
- 根因：`@font-face` 只声明了 500，浏览器静默回退到别的字体，不报错
- 改动：字重必须与 `@font-face` 声明一致（楷 500 / 黑 300·500）
- 判据：截图裁切放大后能看到撇捺笔意

### 2026-10-18 · 引号与引文之间出现 90px 断裂空隙
- 现象：几何体检全过，但视觉上引号和正文像两块
- 根因：引号字形墨迹只占 em 框上沿，`line-height:.66` 留下空白
- 改动：`.qmark` 用 `margin-bottom:-40px` 收回；`qa` 把 `qmark` 排除出重叠检查（属设计意图）
- 判据：联系图上看引号与首行贴合

### 2026-10-18 · 粒子特效被判定为"图形压住正文"
- 现象：带 `particles` 的屏全部报 `fx-overlap-text`
- 根因：粒子是全屏环境层，不是版式元素
- 改动：`qa` 对 `fx.type === 'particles'` 豁免几何约束
- 判据：带粒子的屏 0 误报

### 2026-10-18 · 用截图肉眼调版式，单条视频烧掉 10k token
- 现象：改三轮版式，光看图就花掉 1.5 万字上下文
- 根因：反馈通道太贵——用"看"而不是"量"
- 改动：所有排版问题交给 `qa` 输出几何违规；只在需要目检风格时用 `--sheet` 拼一张联系图
- 判据：正常出片全程不看图，token 1k–3k
