# ascii字符画视频

> 把任意视频**离线**转成本地可播的**全帧率、每字符独立真彩**字符画。
> 全程不联网、不上传、不绑定账号，产物就是一份可随便复制的纯数据。

界面显示名统一为「**ascii字符画视频**」；仓库名、命令名、安装包文件名仍保持
`ascii-full`（改名会断掉已有链接和构建脚本，没必要动）。

```
        .:-=+*#%@#*+=-:.             ← 70 级灰度字形表承载明暗
     .:+#%@$@%#*=-:.::.                ← 每个字符带自己的 24 位 RGB
   .=#@$&8%B@$#*+=-:..          ∞      ← 帧率取源片原生，不丢帧
```

> ✅ **最稳的用法（也是刚实跑通过的那一版）**：不带 `--ramp-file`、不带 `--gamut`，
> 用内置 70 级字形表。自定义字形表与色域声明是 v1.5 的**实验性旁路**，
> 约束见文末「实验性功能」，出问题先看「排错速查」。

---

## 特性

| | 常见网页版 | 本项目 |
|---|---|---|
| 帧率 | 6 fps | **源片原生**（默认） |
| 颜色 | 整帧一个主色 | **每字符独立 RGB**；`--half` 上下双色 |
| 灰度 | 10 级 | **内置 70 级**；实验性 `--ramp-file` 可换 2~256 级字体覆盖率表 |
| 字形绘制 | 逐格 `fillText` | 可选 WebGL 字形图集，一次 draw call 画完整帧 |
| 色域 | 无 | 实验性 `meta.color` 声明 + P3/sRGB 协商（颜色字节不变） |
| 网格 | 固定 64×20 | 按源片比例自动算，默认 282×60 |
| 压缩 | 帧间差分 / 量化 | **只按块 gzip**，不差分、不量化、不丢帧 |
| 依赖 | 浏览器 + 服务端 | ffmpeg + Node，**零 npm 运行时依赖** |

## 四种用法，按「要不要开终端」挑

| 形态 | 给谁 | 怎么用 |
|---|---|---|
| **桌面图形版** | 完全不碰终端 | 装 `ascii-full-desktop-*.exe / .dmg / .AppImage`，选文件点一下 |
| **零安装单文件** | 只想看别人转好的 | 双击 `web/standalone.html`，把产物目录拖进去 |
| **免安装终端版** | 想用命令但不想配环境 | 解压发布包里的 `portable`，内置 Node + ffmpeg |
| **命令行 / npm** | 开发者 | `npm install -g .` 或 `node bin/ascii-full.js` |

四者**读同一份 `meta.json` + `chunks/*.gz`**。桌面版本身就是同一份命令行的图形外壳
（用 `ELECTRON_RUN_AS_NODE` 跑 `bin/ascii-full.js`），所以启动大字、日志、参数行为
完全一致，不会出现「两个版本结果不一样」。

## 真实规模参考

一支 `3388×1440 · 30fps · 210s · 164 MiB` 的宽银幕 PV：

```
--grid 60  → 282×60，6300 帧，105 块
每帧 66 KB · 原始 ≈407 MiB · gzip ≈81~163 MiB
```

| 档位 | 网格 | 每帧 | 原始 | gzip 后（估） |
|---|---|---|---|---|
| `--grid 45` | 212×45 | 37 KB | 229 MiB | 46~92 MiB |
| **`--grid 60`（默认）** | **282×60** | **66 KB** | **407 MiB** | **81~163 MiB** |
| `--grid 90` | 424×90 | 149 KB | 917 MiB | 183~367 MiB |
| `--grid 90 --half` | 424×90 双色 | 261 KB | 1605 MiB | 321~642 MiB |

gzip 比随画面复杂度浮动很大，转码结束会打印真实数字。**先留 1~2 GB 磁盘**。

## 安装

需要 **Node ≥ 18** 和 PATH 里可执行的 `ffmpeg` / `ffprobe`。

```sh
# 直接用，不用装
node bin/ascii-full.js --help

# 或装成全局命令（会多出下面五个 ascii-full-* 命令）
npm install -g .
```

没有素材就先生成一段测试片：

```sh
npm run sample          # 生成 sample.mp4（2 秒彩色测试图）
```

## 快速开始

```sh
ascii-full --src clip.mp4 --out ./ascii-out --grid 60
ascii-full-serve ./ascii-out
```

没装全局就把两条换成 `node bin/ascii-full.js --src ...` 和 `node bin/serve.js ./ascii-out`。

浏览器打开 **`http://127.0.0.1:8080/`** —— 根路径直接进播放器，不用补 `/player.html`。
（你若看到目录列表，那是 `python3 -m http.server` 给的，不是本项目的服务。）

第一次建议先截 3 秒看效果，满意再跑全片：

```sh
ascii-full --src clip.mp4 --out ./ascii-out --grid 60 --to 3 --force
ascii-full --src clip.mp4 --out ./ascii-out --grid 60 --force     # 去掉 --to 即全片
```

`--force` 只清 `chunks/`、`meta.json` 与转码器自己抽的音轨；播放器、
`attach-audio --file` 后期挂的 BGM 都会保留。

**一条链接就够**：`--open` 自动拉起浏览器、`--lan` 给同一 WiFi 下的电视/电脑、
`ascii-full-tunnel` 出临时 https 域名、`--hostname` 绑自己的域、`?src=` 让播放器
直接读远程产物。详见 [docs/URLS.md](docs/URLS.md)。

```sh
ascii-full-serve ./ascii-out 8080 --lan --open
ascii-full-tunnel 8080 --open
```

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

---

## 全部参数

### ① 转码：`ascii-full` / `node bin/ascii-full.js`

| 参数 | 默认 | 说明 |
|---|---|---|
| `--src FILE` | **必填** | 任意 ffmpeg 能解码的视频 |
| `--out DIR` | `./ascii-out` | 输出目录 |
| `--grid N` | `60` | 字符行数；列数按源片比例自动算 |
| `--cols N` | — | 直接指定列数，按比例反算行数（与 `--grid` 二选一） |
| `--fps N` | 源片原生 | 帧率；超过源片时默认只复制帧 |
| `--interp` | 关 | 配合 `--fps` 做 minterpolate 运动补偿插帧，**实验性** |
| `--from S` / `--to S` | `0` / 全片 | 截取区间（秒） |
| `--chunk N` | `60` | 每个 gzip 块装几帧 |
| `--ramp 10\|70` | `70` | 内置灰度级数 |
| `--ramp-file F` | — | 自定义字形表 `ramp.json`（2~256 级，按覆盖率重新量化，**需重转**，实验性） |
| `--gamut MODE` | `auto` | `auto` / `srgb` / `p3` / `expand`（实验性），读 ffprobe 色域标记 |
| `--half` | 关 | 用 `▀` 上下各带一色，垂直分辨率翻倍（体积约 1.75×） |
| `--force` | 关 | 已有产物时清空重跑（保留后期挂的外部音轨） |
| `--audio` / `--no-audio` | 关 | 抽一条主音轨到 `audio/main.webm` / 显式关闭 |
| `--audio-codec C` | `opus` | `opus` / `mp3` / `pcm` |
| `--audio-bitrate R` | `48k` | 音频码率（pcm 忽略） |
| `--audio-id NAME` | `main` | 主音轨 id |
| `--logo TEXT` | `ASCII FULL` | 启动大字文字（点阵只支持 A-Z 0-9 与常用符号） |
| `--logo-char C` | `#` | 大字填充字符 |
| `--logo-file F` | — | 直接读现成 ASCII art（中文、∞ 之类用这个） |
| `--no-logo` | — | 不打印大字 |
| `--log-file F` | `<out>/ascii-full.log` | 日志落盘位置 |
| `--log-level L` | `DEBUG` | `DEBUG` / `INFO` / `WARN` / `ERROR` |
| `--quiet` | — | 控制台只留进度与汇总（日志仍写盘） |
| `--ffmpeg P` / `--ffprobe P` | PATH | 打包版指定二进制，平时不用填 |
| `--version` / `-V`、`--help` | — | 版本号 / 完整参数 |

三个命令启动都会**打印 ASCII 大字 + 环境/参数信息块**，完整时间线写到
`<输出目录>/ascii-full.log`；进度用 `\r` 覆盖不刷屏，每次落块在日志里留一行。

### ② 本地服务：`ascii-full-serve` / `node bin/serve.js`

```
ascii-full-serve [产物目录] [端口] [选项]
```

| 参数 | 默认 | 说明 |
|---|---|---|
| 位置参数 1 | `./ascii-out` | 产物目录 |
| 位置参数 2 | `8080` | 端口 |
| `--open` | 关 | Termux 走 `termux-open-url` 自动拉起浏览器 |
| `--lan` | 关 | 绑 `0.0.0.0` 并枚举 WiFi IP，局域网可看 |
| `--host ADDR` | `127.0.0.1` | 手动指定监听地址（`--lan` 时自动为 `0.0.0.0`） |
| `--public URL` | — | 横幅显示固定域名而不是 `127.0.0.1` |
| `--logo TEXT` / `--logo-char C` / `--logo-file F` / `--no-logo` | — | 启动大字 |

`/` 直出播放器、`/health` 健康检查、`/favicon.ico` 返回 204、
`Cache-Control: no-store`、音频支持 HTTP Range(206)。

### ③ 临时域名：`ascii-full-tunnel` / `node bin/tunnel.js`

```
ascii-full-tunnel [端口] [选项]
```

| 参数 | 默认 | 说明 |
|---|---|---|
| 位置参数 | `8080` | 本地服务端口 |
| `--provider ssh\|cloudflared` | `ssh` | `ssh` 零安装走 22；被掐就换 `cloudflared` 走 443 |
| `--open` | 关 | 拿到域名后自动拉起浏览器 |
| `--hostname 域名` | — | 不建隧道，只打印固定域名绑定步骤 |
| `--logo TEXT` / `--no-logo` | — | 启动大字 |
| `--help` | — | 完整说明 |

这是**串流**不是上传：产物不上传、手机/电脑不能关服务。拿到域名写进 `tunnel.url`。

### ④ 旁路音轨：`ascii-full-attach-audio` / `node bin/attach-audio.js`

```
node bin/attach-audio.js --out DIR --src VIDEO [选项]
node bin/attach-audio.js --out DIR --file AUDIO [选项]
node bin/attach-audio.js --out DIR --list | --remove ID | --master ID
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--out DIR` | `./ascii-out` | 产物目录 |
| `--src FILE` | — | 从视频抽音轨（区间自动取 `meta.from / meta.to`） |
| `--file FILE` | — | 直接挂现成音频文件，不重编码 |
| `--id NAME` | `main` | 轨 id；已占用时顺延 `track2` / `track3`… |
| `--codec C` / `--bitrate R` | `opus` / `48k` | 从 `--src` 抽取时的编码与码率 |
| `--gain 0~4` | `1` | 该轨音量，播放器里也能实时拖 |
| `--offset S` | `0` | 相对主时钟偏移（秒，可负） |
| `--role master` | 第一条自动 | 把新轨设为主时钟 |
| `--replace` | 关 | 同 id 覆盖而不是顺延（**没有 `--force`**） |
| `--list` / `--remove ID` / `--master ID` | — | 列出 / 删除 / 换主时钟轨 |
| `--ffmpeg P` / `--ffprobe P` | PATH | 打包版指定二进制 |

只写 `audio/` 与 `meta.json`，`chunks/` 一个字节不动；写 meta 时自动把产物里的
`player.html` 升到新版（已是新版则不覆盖自定义播放器）。

### ⑤ 终端播放：`ascii-full-term` / `node bin/ascii-full-term.js`

```
ascii-full-term [产物目录] [选项]
```

| 参数 | 默认 | 说明 |
|---|---|---|
| 位置参数 | `./ascii-out` | 产物目录 |
| `--speed N` | `1` | 播放倍速 |
| `--start F` | `0` | 从第几帧开始 |
| `--stride N` | `1` | 跳帧步长 |
| `--cache N` | `5` | 内存 LRU 驻留块数 |
| `--logo TEXT` / `--logo-char C` / `--logo-file F` / `--no-logo` | — | 启动大字 |
| `--log-level L` / `--quiet` | — | 日志级别 / 精简控制台 |

需要 `$COLORTERM=truecolor` 且终端宽度 ≥ `meta.W`；行内连续同色会合并转义序列，
Ctrl-C 恢复光标。终端播放**无声**。

### ⑥ 播放器地址参数（两个 HTML 通用）

| 参数 | 默认 | 说明 |
|---|---|---|
| `?src=https://域名/路径/` | 同目录 | 从任意域名读 `meta.json` + `chunks/*.gz`（对方需放行 CORS） |
| `?cache=N` | `6` | 内存 LRU 驻留块数，电脑可给 `12` |
| `?mute=1` | 关 | 起播静音 |
| `?offset=-120` | `0` | 音画偏移，**毫秒** |
| `?nogl=1` | 关 | 强制退回 2D 字符路径（排查字形/图集问题时用） |

面板：播放/暂停、0.5×~4× 变速、拖帧、`字符 ↔ 色块`、截 PNG、全屏、
`− / ＋ / 100% / 适应`（0.5×~8×）、拖动平移、双指缩放、亮度、
`追帧 / 平滑`、`🔊 开声音`、`音轨 N`（逐轨音量 + 偏移）、状态栏 `渲染 xx/24fps`。

---

## 播放器

- **零安装单文件**（给普通人）：`web/standalone.html` 双击即开，把产物目录拖进去。
  用 File API 直接读本地文件，**不需要服务、不受 `file://` 的 CORS 限制**，全离线。
- **浏览器**：用 `DecompressionStream('gzip')` 按块取帧，首屏只请求当前那一个 chunk，
  并预取下一块。画布按每字符 8×16 逻辑像素出**真实尺寸**（不会被压进屏宽），
  所以放大 4×~8× 能看清每个字符的笔画。
- **终端**：见上表。

三者都只读 `meta.json` + `chunks/*.gz`（有音轨时再加 `audio/`），不依赖本仓库运行；
桌面版的「打开播放器」会自动起一个仅本机可访问的临时服务并新开窗口。

### 放大与超采样

**先放大看，再决定要不要重转。** 早期版本把 `W` 列强行压进屏幕宽度，手机竖屏上
每字符常只有 2px 宽、字形根本画不出来，看上去就是一片暗糊的点 —— 不是源片糊，
是渲染尺寸太小。放大属于纯显示，**产物一个字节不变**。

放大后仍觉得细节不够，才在转码侧提高密度：

| 4K 16:9 源片 | 网格 | 字符数/帧 | 每帧字节 |
|---|---|---|---|
| 默认 | 213×60 | 12 780 | 51 120 B |
| `--cols 426` | 426×120 | 51 120（4×） | 204 480 B |
| `--cols 852` | 852×240 | 204 480（**16×**） | 817 920 B |

这里的 16× 是**相对默认 `213×60` 网格**的格数倍数（852×240 ÷ 213×60），
不是「一个源像素用 16 个字符表达」—— 4K 源片横向仍有约 4.5 个源像素合并成一格。
字符数 ×16，帧数/帧率不变时产物也 ×16，4K/30fps/3 分钟在 852×240 下会到 5 GB 量级，
所以推荐先试 `--cols 426`，或只截 `--from/--to` 一段做高密度版。

> 观感补充：格点变密、同样距离下每格的角尺寸变小，人眼会把块平均成连续色调，
> 「打码感」会真实下降 —— 但**信息量没增加**，阈值由屏幕 PPI 和观看距离定，
> 不是越大越高级。

### 缓存

播放器在**内存里**维护有界 LRU：浏览器默认 6 块（`?cache=12` 可调）、终端默认 5 块
（`--cache 10`）。命中时把该块挪到末尾，超出上限才淘汰最久未用的。顺序播放有预取，
常驻通常只有 2~3 块，状态栏数字看着不动不是没在管，是没攒起来。

`serve.js` 设了 `Cache-Control: no-store`，改完产物刷新即生效。
**磁盘上的 `chunks/*.gz` 是产物，不是缓存**，永不自动删除：转码可能跑几十分钟，
自动清理等于可能毁掉唯一副本。想重来就显式 `--force` 或换 `--out`。

---

## 实验性功能（v1.5）

v1.4 把声音拆成旁路，v1.5 把「字形」和「色域」也拆成旁路：
`chunks/` 仍是 `1B 索引 + 3B RGB`，`frameBytes` 一个字节没动。

**换字**（从字体量覆盖率，不再靠经验排 `@%#*`）：

```sh
python3 scripts/gen-ramp.py --levels 200 --out ./ramp
ascii-full --src clip.mp4 --out ./ascii-out --ramp-file ./ramp/ramp.json --force
```

**色域**（默认 `auto` 读 ffprobe 标记，BT.709 / 未标注的 SDR 如实写 `srgb`）：

```sh
ascii-full --src clip.mp4 --out ./ascii-out --gamut auto
```

播放端按屏幕能力协商：P3 屏按 `display-p3` 呈现，sRGB 屏走线性光 3×3 矩阵压回；
`expand` 是有意变艳、明确标为实验性。字形预烘焙成图集纹理后，每帧只上传
「索引 + RGB」两张小纹理，一次 draw call 画完整帧，绕开逐格 `fillText`，
CJK 双宽也不会串格。无 WebGL / `--half` / 老产物一律回退 2D。

**四条实话**：

1. **1 字节索引 = 256 级硬顶**；换表要重转一次，因为索引语义变了。
2. 转码时用的 `ramp.json` 和播放时读的**必须是同一份**，连同 `ramp-atlas.png`
   一起放在产物目录里；表与索引错配会整帧发黑或字形全错。
3. 源片是 SDR 时强制 `p3` **不会凭空增加颜色**，只是声明。
4. 出问题先 `?nogl=1`；最干净的恢复是**删掉产物、不带 `--ramp-file` 重转**
   （回到内置 70 级），索引语义零歧义。

详见 [RAMP.md](docs/RAMP.md) / [COLOR.md](docs/COLOR.md) /
[FORMAT.md](docs/FORMAT.md) / [排错](docs/TROUBLESHOOTING.md)。

## 排错速查

| 现象 | 处理 |
|---|---|
| `✗ 无法执行 ffmpeg` | 先 `ffmpeg -version`；转码器直接执行它探测，不用 `which` |
| 打开是目录列表 / `player.html 404` | 用 `ascii-full-serve`，根路径 `/` 直出播放器 |
| 站在被删目录里起 node 报 `uv_cwd` | 先 `cd ~` 再跑，别站在要 `rm -rf` 的目录里 |
| `✗ 已存在 meta.json` | 加 `--force`，或换一个 `--out` |
| 字符模式一片黑，色块 / `?nogl=1` 正常 | 索引与字形表错配 → 删产物、不带 `--ramp-file` 重转 |
| 画面一顿一顿 | 看状态栏 `渲染 xx/24fps`；点「色块」或先放大再判断 |
| 没声音 | 点一下 `🔊 开声音`（浏览器拦无手势有声播放） |

完整版见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

## 仓库结构

```
bin/ascii-full.js       转码器（ffmpeg 流式抽帧 → rgb24 → 字符格 → gzip 分块）
bin/ascii-full-term.js  终端播放器（无声）
bin/serve.js            零配置静态服务（--open / --lan / Range 206）
bin/attach-audio.js     旁路音轨管理：抽/挂/列/删/换主时钟，不碰 chunks
bin/tunnel.js           临时 https 域名（cloudflared / SSH 反向转发）
bin/banner.js           5×7 点阵 ASCII 大字（可自定义文字/填充/外部 art）
bin/logger.js           结构化启动日志、进度落盘、汇总
web/player.html         浏览器播放器（转码时自动复制进产物目录）
web/standalone.html     零安装单文件播放器（拖目录即播）
web/_render-core.js     共用渲染核心：色域协商 / 字形表解析 / WebGL 图集
desktop/                Electron 图形版（内置 ffmpeg，复用同一份命令行）
scripts/build-portable.sh 组装免安装终端版
scripts/gen-ramp.py     从字体量出字形覆盖率表（生成时用 fontTools + Pillow）
scripts/inline-core.js  把渲染核心逐字内联进两个播放器
.github/workflows/      自检与一键发布流水线
docs/                   格式、音频、字形表、色域、链接、桌面版、排错
examples/               合成测试片脚本
test/                   零依赖端到端自检
```

## 图形版与一键发布

```sh
git tag v1.5.0 && git push origin v1.5.0
```

`.github/workflows/release.yml` 会在 Windows / macOS / Linux 三地自动产出：

- `ascii-full-1.5.0-*.exe / .dmg / .AppImage` —— 桌面图形版
- `ascii-full-1.5.0-portable-<平台>.zip / .tar.gz` —— 免安装终端版（内置 Node + ffmpeg）
- `ascii-full-1.5.0-standalone.html` —— 零安装单文件播放器
- `SHA256SUMS.txt`

本地想预览图形版：

```sh
cd desktop && npm install && npm start      # npm run build 可本地出安装包
```

详见 [docs/DESKTOP.md](docs/DESKTOP.md)。

## 设计取舍

- **不做帧间差分**：字符画帧本身已很小，差分会让「任意拖帧」变复杂。
- **不量化颜色**：每字符 4 B（索引 + RGB），镜头里每一点颜色都还在。
- **按块 gzip 而非整片压缩**：播放器只需取当前帧所在的那一个块，内存可控。
- **ASCII 本身是有损映射**：这里的「完整」指参数一个不让步，不是数学无损，
  真无损请留着原片。
- **比例不失真**：等宽字符格约 1:2，`W = round(2 · srcW/srcH · H)`，宽银幕不会被压扁。

## 测试

```sh
npm test
```

会合成一段彩色测试片，跑普通与 `--half` 两种模式，逐块校验 gzip 解压后的裸字节数、
字形索引范围、`meta.json` 字段、自动复制播放器、内置 HTTP 服务（含目录穿越拦截与
`.gz` 响应头）、终端播放器的 truecolor 输出，以及启动大字、日志落盘、5×7 字体表、
桌面版/独立播放器/发布流水线的文件齐备性。零第三方依赖，CI 里也能直接跑。

## 发布前

1. 把 `LICENSE` 里的 `ascii-full contributors` 换成你的名字 / 组织。
2. 在 `package.json` 补 `repository` / `author` / `bugs` 字段。
3. `npm pack --dry-run` 看一眼将要发布的文件（`files` 字段已限定范围）。
4. 想发 npm：`npm publish`；想发安装包：推上去后 `git tag v1.5.0 && git push origin v1.5.0`。
5. 需要可复现的图形版构建，可在 `desktop/` 里跑一次 `npm install` 并把生成的
   `desktop/package-lock.json` 一起提交。

## 许可协议

MIT · 依赖 [FFmpeg](https://ffmpeg.org/) 与 Node.js 内置模块，无其他运行时依赖。

## 版本记录

- **v1.5.0**：字形表与色域各自单独成路；WebGL 图集一次 draw call
- **v1.4.0**：声音单独成一路，可叠加多轨、可不重转补音轨
- **v1.3.0**：入口从「两个 HTML 文件」改成「一条 URL」，支持局域网与临时域名
- **v1.2.1**：渲染帧率显示、`--interp` 运动补偿插帧
- **v1.2.0**：大画布与超采样
- **v1.1.0 / v1.0.0**：四种形态、基础转码格式

完整说明见 [CHANGELOG.md](CHANGELOG.md)。
