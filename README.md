# ascii-full

> Offline full-fps 24-bit truecolor ASCII video transcoder.
> 把任意视频转成本地可播的**全帧率、每字符独立真彩**字符画，全程离线、零 npm 运行时依赖。

给视频做 ASCII 化，常见做法是降到 6~12 fps、整帧共用一个主色、10 级灰度 ——
那是为了塞进网页。这个项目反过来：**不为体积让步**，为本地收藏、终端放映、
二次创作保留尽可能多的原始信息。

```
        .:-=+*#%@#*+=-:.             ← 70 级灰度 ramp 承载亮度
     .:+#%@$@%#*=-:.::.                ← 每个字符带自己的 24-bit RGB
   .=#@$&8%B@$#*+=-:..          ∞      ← 帧率取源片原生，不丢帧
```

## 特性

| | 常见 Web 版 | ascii-full |
|---|---|---|
| 帧率 | 6 fps | **源片原生**（默认） |
| 颜色 | 整帧一个主色 | **每字符独立 RGB**；`--half` 上下双色 |
| 灰度 | 10 级 | **70 级** |
| 网格 | 固定 64×20 | 按源片比例自动算，默认 282×60 |
| 压缩 | 帧间差分 / 量化 | **只按块 gzip**，不差分、不量化、不丢帧 |
| 依赖 | 浏览器 + 服务端 | ffmpeg + Node，**零 npm 依赖** |

产物是纯数据，不联网、不上传、不绑定任何账号。

## 四种用法，按「要不要开终端」挑

| 形态 | 给谁 | 怎么用 |
|---|---|---|
| **桌面图形版** | 完全不碰终端 | 装 `ascii-full-desktop-*.exe / .dmg / .AppImage`，选文件点一下 |
| **零安装单文件** | 只想看别人转好的 | 双击 `web/standalone.html`，把产物目录拖进去 |
| **免安装终端版** | 想用命令但不想配环境 | 解压 Release 里的 `portable` 包，内置 Node + ffmpeg |
| **npm / CLI** | 开发者 | `npm install -g .` 或 `node bin/ascii-full.js` |

四者**读同一份 `meta.json` + `chunks/*.gz`**，桌面版转出来的产物，独立 HTML 照样能播。
桌面版本身也是同一份 CLI 的图形外壳（用 `ELECTRON_RUN_AS_NODE` 跑 `bin/ascii-full.js`），
所以启动大字、日志、参数行为完全一致，不会出现「两个版本结果不一样」。

## 真实规模参考

一支 `3388×1440 · 30fps · 210s · 164 MiB` 的宽银幕 PV：

```
--grid 60  → 282×60, 6300 帧, 105 块
每帧 66 KB · 原始 ≈407 MiB · gzip ≈81~163 MiB
```

| 档 | 网格 | 每帧 | 原始 | gzip 后（估） |
|---|---|---|---|---|
| `--grid 45` | 212×45 | 37 KB | 229 MiB | 46~92 MiB |
| **`--grid 60`（默认）** | **282×60** | **66 KB** | **407 MiB** | **81~163 MiB** |
| `--grid 90` | 424×90 | 149 KB | 917 MiB | 183~367 MiB |
| `--grid 90 --half` | 424×90 双色 | 261 KB | 1605 MiB | 321~642 MiB |

gzip 比随画面复杂度浮动很大；转码结束会打印真实数字。**先留 1~2 GB 磁盘**。

## 安装

需要 **Node ≥ 18** 和 PATH 里可执行的 `ffmpeg` / `ffprobe`。

```sh
# 直接用，不用装
node bin/ascii-full.js --help

# 或装成全局命令（会多出 ascii-full / ascii-full-term / ascii-full-serve）
npm install -g .
# 本地链接也行：npm link
```

没有素材就先生成一段测试片：

```sh
npm run sample          # 生成 sample.mp4（2 秒彩色测试图）
```

## Quick start

```sh
ascii-full --src clip.mp4 --out ./ascii-out --grid 60
ascii-full-serve ./ascii-out
```

没装全局就把两条换成
`node bin/ascii-full.js --src ...` 和 `node bin/serve.js ./ascii-out`。

浏览器打开 **`http://127.0.0.1:8080/`** —— 根路径直接进播放器，不用补 `/player.html`。

想让 Termux 自动拉起 Edge：`ascii-full-serve ./ascii-out 8080 --open`。
想要一条能发出去的域名链接：见 [docs/URLS.md](docs/URLS.md)
（`ascii-full-tunnel` 出临时 https 域名、`--lan` 出局域网链接、
`--hostname` 绑自己的域、`?src=` 让播放器直接读远程产物）。
第一次建议先截 3 秒看效果，满意再跑全片：

```sh
ascii-full --src clip.mp4 --out ./ascii-out --grid 60 --to 3 --force
ascii-full --src clip.mp4 --out ./ascii-out --grid 60 --force     # 去掉 --to 即全片
```

`--force` 只清 `chunks/`、`meta.json` 与转码器自己抽的音轨；播放器、
`attach-audio --file` 后期挂的 BGM 都会保留。

## 音频：旁路、可叠加、可不重转

> v1.3 及更早只取 `v:0`，音轨压根没进过格式。v1.4 起画面与声音分成两条独立的路。

```sh
# 新产物：转码时一次带上
ascii-full --src clip.mp4 --out ./ascii-out --audio

# 已有产物：补主音轨，不重转画面（几 GB 的 chunks 一个字节不动）
node bin/attach-audio.js --out ./ascii-out --src clip.mp4

# 叠加 BGM / 解说 / 多语种，直接挂现成音频、不重编码
node bin/attach-audio.js --out ./ascii-out --file bgm.m4a --id bgm --gain 0.6 --offset 1.5
node bin/attach-audio.js --out ./ascii-out --list
```

`meta.audio.tracks[]` **从第一天就是数组**：第一条为 `master` 主时钟，其余为
`overlay`，每条自带 `gain / offset / role`。播放器丢掉自数的时间轴，改由主时钟轨的
`currentTime` 算帧，拖帧、变速、切后台都不会音画错位；底部「音轨 N」面板可逐轨调音量、
全局 `音画 ±ms` 微调。没有 `meta.audio` 的老产物完全走旧时钟，零回归。

浏览器会拦截无手势的有声自动播放 —— 被拦时自动降级静音、按钮变成 `🔇 开声音`，
**点一下解锁**（或按 `M`）。内置服务已给音频补了正确 MIME 与 HTTP Range(206)。
详见 [docs/AUDIO.md](docs/AUDIO.md) 与 [FORMAT.md](docs/FORMAT.md#audio--旁路多轨音频v14)。

## CLI

| 参数 | 说明 |
|---|---|
| `--src FILE` | **必填**，任意 ffmpeg 能解码的视频 |
| `--out DIR` | 输出目录，默认 `./ascii-out` |
| `--grid N` | 字符行数，默认 60；列数按宽高比自动算 |
| `--cols N` | 直接指定列数；单独给时按比例反算行数，用于高密度超采样 |
| `--fps N` | 帧率，默认取源片原生 |
| `--from S` / `--to S` | 截取区间；不写 `--to` = 全片 |
| `--chunk N` | 每个 gzip 块装几帧，默认 60 |
| `--ramp 10\|70` | 灰度级数，默认 70 |
| `--half` | 用 `▀` 上下各带一色，垂直分辨率翻倍 |
| `--audio` | 从源片抽一条主音轨到 `audio/main.webm`（默认关闭） |
| `--audio-codec opus\|mp3\|pcm` | 音频编码，默认 opus |
| `--audio-bitrate R` / `--audio-id N` | 默认 `48k` / `main` |
| `--force` | 已有产物时清空重跑（保留 `--file` 后挂的外部音轨） |
| `--logo TEXT` | 启动 ASCII 大字的文字，默认 `ASCII FULL` |
| `--logo-char C` / `--logo-file F` | 换填充字符 / 直接读现成 ASCII art |
| `--no-logo` | 关掉大字 |
| `--log-file F` / `--log-level L` / `--quiet` | 日志落盘、级别、精简控制台 |
| `--ffmpeg P` / `--ffprobe P` | 指定二进制路径（打包版用，平时不用填） |
| `--version` / `--help` | |

三个命令启动时都会**打印 ASCII 大字 + 环境/参数信息块**，并把完整时间线写到
`<输出目录>/ascii-full.log`；进度用 `\r` 覆盖不刷屏，但每次落块会在日志里留一行。
`--quiet` 只压掉过程日志，汇总与耗时仍保留。

`ascii-full-term [DIR] [--speed N] [--start F] [--stride N] [--cache 5]`
在 truecolor 终端里直接播；`ascii-full-serve [DIR] [PORT] [--open]` 起本地静态服务
并自动开浏览器（等价 `python3 -m http.server`）。

## 播放器

- **零安装单文件**（给普通人）：`web/standalone.html` 双击即开，把产物目录拖进去。
  用 File API 直接读本地文件，**不需要服务、不受 `file://` 的 CORS 限制**，全离线。
- **浏览器**：播放/暂停、0.5×~4× 变速、拖帧、字符↔色块切换、截 PNG、全屏。
  用 `DecompressionStream('gzip')` 按块取帧，首屏只请求当前那一个 chunk，并预取下一块。
  **画布允许变大**：默认按每字符 8×16 逻辑像素出真实尺寸（不会被压进屏宽），
  `− / ＋ / 100% / 适应` 在 0.5×~8× 间切换，可拖动画布平移、双指 pinch 缩放；
  另有亮度滑块提亮暗部。
- **终端**：`ascii-full-term`，行内连续同色合并转义序列，Ctrl-C 恢复光标。
  需要 `$COLORTERM=truecolor` 且终端宽度 ≥ `meta.W`。

三者都只读 `meta.json` + `chunks/*.gz`（有音轨时再加 `audio/`），不依赖本仓库运行；桌面版的「打开播放器」
会自动起一个仅本机可访问的临时服务并新开窗口，等价于第二条。

### 放大与超采样

**先放大看，再决定要不要重转。** 早期版本把 `W` 列强行压进屏幕宽度，手机竖屏上
每字符常只有 2px 宽、字号 3.7px，字形根本画不出来，看上去就是一片暗糊的点 ——
这不是源片糊，也不是转码掉画质，纯粹是渲染尺寸太小。现在默认出真实大画布，
放大到 4×~8× 就能看清每个字符的笔画；配亮度滑块可把挤在 ramp 前几级的暗部拉出来。

如果放大后仍觉得**细节不够**（一个源采样区域确实只用了一个字符描述），那才需要
在转码侧提高网格密度，用 `--cols`：

| 4K 16:9 源片 | 网格 | 字符数/帧 | 每帧字节 |
|---|---|---|---|
| 默认 | 213×60 | 12 780 | 51 120 B |
| `--cols 426` | 426×120 | 51 120（4×） | 204 480 B |
| `--cols 852` | 852×240 | 204 480（**16×**） | 817 920 B |

`--cols 852` 就是「原来 1 个字符的位置用 4×4 = 16 个字符表达」，画面比例由脚本
自动反算行数保持不变。**代价是真实的**：字符数 ×16，帧数/帧率不变时产物也 ×16。
4K/30fps/3 分钟在 852×240 下会到 5 GB 量级，所以推荐先试 `--cols 426`（×4），
或只截 `--from/--to` 一段做高密度版。播放器放大属于纯显示，产物一个字节不变。

### 缓存

播放器在**内存里**维护一个有界 LRU：浏览器默认 6 块（`?cache=12` 可调）、
终端默认 5 块（`--cache 10`）。命中时把该块挪到末尾，超出上限才淘汰最久未用的那块。
顺序播放因为有预取，常驻通常只有 2~3 块，根本碰不到上限 —— 所以状态栏数字看着不动，
不是没在管，是没攒起来。

`serve.js` 对响应设了 `Cache-Control: no-store`，浏览器 HTTP 层不落盘缓存，
每次 `ensureChunk` 都是真请求（改完产物刷新即生效）。

**磁盘上的 `chunks/*.gz` 是产物，不是缓存**，永不自动删除：转码可能跑几十分钟，
自动清理等于可能毁掉唯一副本。想重来就显式 `--force`（只清 `chunks/` 与 `meta.json`），
或换一个 `--out` 目录。

## 仓库结构

```
bin/ascii-full.js       转码器（ffmpeg 流式抽帧 → rgb24 → 字符格 → gzip 分块）
bin/ascii-full-term.js  终端播放器（无声）
bin/serve.js            零配置静态服务（--open / --lan / HTTP Range 206）
bin/attach-audio.js     旁路音轨管理：抽/挂/列/删/换主时钟，不碰 chunks
bin/tunnel.js           临时 https 域名（cloudflared / localhost.run）
bin/banner.js           5×7 点阵 ASCII 大字（可自定义文字/填充/外部 art）
bin/logger.js           结构化启动日志、进度落盘、汇总
web/player.html         浏览器播放器（转码时自动复制进产物目录）
web/standalone.html     零安装单文件播放器（拖目录即播）
desktop/                Electron 图形版（内置 ffmpeg，复用同一份 CLI）
scripts/build-portable.sh 组装免安装终端版
.github/workflows/release.yml  打 tag 自动出桌面包 / 免安装包 / 独立 HTML
docs/FORMAT.md          数据格式 v1：字段、二进制布局、audio.tracks[]、最小读取示例
docs/AUDIO.md           音频：旁路 / 多轨叠加 / 不重转补音轨 / 自动播放解锁
docs/URLS.md            端口、--lan、https 隧道、域名绑定、?src= 远程读取
docs/DESKTOP.md         图形版与 Release 产物说明
docs/TROUBLESHOOTING.md 排错（含 Termux / file:// / 404 等实战坑）
examples/               合成测试片脚本
test/smoke.js           零依赖端到端烟测
```

## 图形版与一键 Release

```sh
git tag v1.2.1 && git push origin v1.2.1
```

`.github/workflows/release.yml` 会在 Windows / macOS / Linux 三地 runner 上自动产出：

- `ascii-full-1.2.1-*.exe / .dmg / .AppImage` —— 桌面图形版
- `ascii-full-1.2.1-portable-<平台>.zip / .tar.gz` —— 免安装终端版（内置 Node + ffmpeg）
- `ascii-full-1.2.1-standalone.html` —— 零安装单文件播放器
- `SHA256SUMS.txt`

本地想预览 GUI：

```sh
cd desktop && npm install && npm start      # npm run build 可本地出安装包
```

详见 `docs/DESKTOP.md`。

## 设计取舍

- **不做帧间差分**：字符画帧本身已很小，差分会让「任意拖帧」变得复杂，
  违背「完整版」的初衷。
- **不量化颜色**：每字符 4 B（索引 + RGB），换来的是镜头里每一点颜色都还在。
- **按块 gzip 而非整片压缩**：播放器只需取当前帧所在的那一个块，内存可控。
- **ASCII 本身是有损映射**：这里的「完整」指参数一个不让步，不是数学无损。
  真无损请留着原片。
- **比例不失真**：等宽字符格约 1:2，`W = round(2 · srcW/srcH · H)`，
  宽银幕片不会被压扁。

## 测试

```sh
npm test
```

会合成一段彩色测试片，跑 plain 与 `--half` 两种模式，逐块校验 gzip 解压后的
裸字节数、ramp 索引范围、`meta.json` 字段、自动复制播放器、内置 HTTP 服务
（含目录穿越拦截与 `.gz` 响应头）、终端播放器的 truecolor 输出，以及启动大字、
日志落盘、5×7 字体表、桌面版/独立播放器/Release 流水线的文件齐备性。
零第三方依赖，CI 里也能直接跑。

## 发布前

1. 把 `LICENSE` 里的 `ascii-full contributors` 换成你的名字 / 组织。
2. 在 `package.json` 补 `repository` / `author` / `bugs` 字段。
3. `npm pack --dry-run` 看一眼将要发布的文件（`files` 字段已限定范围，
   桌面版与 workflow 只进 GitHub 仓库、不进 npm 包）。
4. 想发 npm：`npm publish`；想发安装包：仓库推上去后 `git tag v1.4.0 && git push origin v1.4.0`。
5. 需要可复现的 GUI 构建，可在 `desktop/` 里跑一次 `npm install` 并把生成的
   `desktop/package-lock.json` 一起提交（当前 workflow 用 `npm install` 也能跑通）。

## License

MIT · 依赖 [FFmpeg](https://ffmpeg.org/) 与 Node.js 内置模块，无其他运行时依赖。


## v1.2.1 · 渲染帧率

`--fps` 默认取源片原生帧率、不丢帧；但高密度网格（如 `--cols 426` →
426×120 = 51120 cells/帧）下，旧播放器逐 cell 调用 canvas API 根本画不完
24fps，观感像掉帧。v1.2.1 把渲染改成：亮度查表、色块走 `ImageData` 一次成图、
字符按颜色分组批量绘制、空格跳过，并在状态栏实时显示 `渲染 X/Y fps`。

新增 `--interp`（配合 `--fps`）做运动补偿插帧，`meta.json` 增加
`interp` / `fpsUpsampled` 字段以区分「真插帧」和「复制帧」。详见
[排错文档](docs/TROUBLESHOOTING.md#感觉帧率很低--画面一顿一顿)。

## v1.4.0 · 声音单独成一路

之前整条管线只取 `v:0`，音轨从进 ffmpeg 那一刻就被丢了 —— 不是静音开关，
是声音从来没进过格式。v1.4 把画面与声音彻底拆开：`chunks/` 只管画，
`audio/` 只管声，`meta.audio.tracks[]` 把两者关联起来。

- `--audio` 抽主音轨；`attach-audio --src` 给**已有产物**补音轨，不重转画面
- `attach-audio --file` 直接挂现成音频（不重编码），可无限叠加 BGM / 解说 / 多语种
- 每条轨独立 `gain / offset / role`，`--list / --remove / --master` 管理
- 播放器改用主时钟轨的 `currentTime` 算帧，音画不再靠两个钟各自走
- 内置服务补音频 MIME 与 HTTP Range(206)；被浏览器拦有声自动播放时降级静音并提示解锁
- `--force` 重转画面只删转码器自己抽的音轨，`source:'file'` 的外部轨原样继承

格式细节见 [FORMAT.md](docs/FORMAT.md#audio--旁路多轨音频v14)，操作见 [AUDIO.md](docs/AUDIO.md)。
