# 数据格式 v1

产物是**纯数据**，不含可执行代码、不含服务端逻辑：

```
ascii-out/
├── meta.json          # 描述文件（UTF-8 JSON）
├── player.html        # 转码时自动复制进来的浏览器播放器
├── chunks/            # 画面：每块 N 帧的 gzip 裸字节
│   ├── c_00000.gz
│   └── ...
└── audio/             # 声音：旁路，与 chunks 完全独立（仅 --audio 时生成）
    ├── main.webm      # 主音轨
    ├── bgm.m4a        # 后期用 attach-audio 追加的叠加轨
    └── ...
```

**画面与声音是两条独立的路**：`chunks/` 只管画，`audio/` 只管声，两者只通过
`meta.audio.tracks[]` 关联。这意味着补音轨、换音轨、叠 BGM / 解说 / 多语种，
都**不用重转画面**，几个 GB 的帧数据一个字节不动。

只要按下面规则读，就能用任何语言写自己的播放器。

## meta.json

| 字段 | 含义 |
|---|---|
| `magic` | 固定 `ASCFULL1` |
| `version` | 固定 `1` |
| `src`, `srcW`, `srcH`, `srcCodec`, `srcDuration`, `srcFps` | 源片信息，仅供展示 |
| `W`, `H` | 字符网格的列数、行数 |
| `fps` | 实际采用的帧率（默认源片原生） |
| `interp` | 是否用 `minterpolate` 运动补偿插帧（仅当 `--fps` 高于源片且带 `--interp`） |
| `fpsUpsampled` | `fps` 是否高于源片；为 true 且 `interp=false` 时是 ffmpeg 复制帧填充，不增加信息 |
| `ramp` | 灰度字符表字符串，索引即字符 |
| `colors` | 每 cell 的颜色数：plain `1` / half `2` |
| `half` | 是否用 `▀` 上下双色 |
| `bytesPerCell` | plain `4` / half `7` |
| `frameBytes` | `W * H * bytesPerCell` |
| `chunkFrames` | 每个 gzip 块最多装几帧 |
| `frames`, `chunks` | 总帧数、总块数 |
| `from`, `to` | 截取区间（秒） |
| `generatedAt` | ISO 时间 |
| `audio` | 可选。`{ version:1, master:0, tracks:[…] }`；没有这个字段 = 老产物 / 静音 |
| `audioUpdatedAt` | 用 `attach-audio` 改过音轨后写入，`generatedAt` 不变 |

### 网格宽度怎么来的

等宽字体的字符格约为 **宽:高 = 1:2**，要还原源片比例 `srcW/srcH`，需满足
`W / (2H) = srcW / srcH`，所以：

```
W = round(2 * srcW / srcH * H)
```

例如 3388×1440（2.353:1）、`--grid 60` → `W = 282`。这样不会把宽银幕压扁。

## chunks/*.gz

每块文件名 `c_%05d.gz`，内容是 **N 帧裸字节直接拼接**，N 通常等于
`chunkFrames`，最后一块可能更少：

```
N = min(chunkFrames, frames - 块序号 * chunkFrames)
gunzip(文件).length === N * frameBytes
```

帧内按**行优先**排列，`cell(y, x)` 的偏移是
`frameBase + (y * W + x) * bytesPerCell`。

### plain（默认，4 B/cell）

| 偏移 | 内容 |
|---|---|
| `+0` | ramp 字符索引（`0 … len(ramp)-1`） |
| `+1..3` | R, G, B（各 1 字节，0–255） |

渲染：`ramp[idx]` 作为字符，RGB 作为前景色。

### half（`--half`，7 B/cell）

| 偏移 | 内容 |
|---|---|
| `+0` | ramp 字符索引（上下像素平均亮度） |
| `+1..3` | 上半像素 R, G, B → `▀` 前景 |
| `+4..6` | 下半像素 R, G, B → `▀` 背景 |

`--half` 时 ffmpeg 实际采样高度为 `2H`，因此垂直颜色分辨率翻倍。

## 亮度与索引

```
lum = 0.2126*R + 0.7152*G + 0.0722*B          // Rec.709
idx = clamp(floor(lum / 256 * len(ramp)), 0, len(ramp)-1)
```

默认 ramp 70 级；`--ramp 10` 切到 `" .:-=+*#%@"`。字符只承载亮度，
颜色完全由独立 RGB 承担 —— 这是「真彩字符画」和普通 ASCII 灰度的区别。

## 关于 gzip

- 用 `zlib.gzipSync(body, { level: 6 })` 按块压缩，**不做帧间差分、不量化、不丢帧**。
- 服务端返回 `.gz` 时**不要**加 `Content-Encoding: gzip`：文件是数据不是传输编码，
  播放器用 `DecompressionStream('gzip')`（浏览器）/ `zlib.gunzipSync`（Node）自己解。
- 按块压缩是为了流式：播放器只取当前帧所在的那一个块，不必一次读完整个文件。

## audio/ · 旁路多轨音频（v1.4）

`audio` 从第一天就是**数组**，不是单文件 —— 这是为了后期叠加：
加一条轨 = 往 `tracks[]` push 一项，播放器、转码器、本文档都不用改。

```json
"audio": {
  "version": 1,
  "master": 0,
  "tracks": [
    {
      "id": "main",
      "file": "audio/main.webm",
      "codec": "opus",
      "mime": "audio/webm; codecs=opus",
      "sampleRate": 48000,
      "channels": 2,
      "bitrate": "48k",
      "duration": 211.9,
      "srcStart": 0,
      "offset": 0,
      "gain": 1,
      "role": "master",
      "source": "video"
    },
    {
      "id": "bgm",
      "file": "audio/bgm.m4a",
      "codec": "aac",
      "mime": "audio/mp4",
      "offset": 1.5,
      "gain": 0.6,
      "role": "overlay",
      "source": "file"
    }
  ]
}
```

| 字段 | 含义 |
|---|---|
| `master` | 主时钟轨在 `tracks` 里的下标；**帧索引跟着它的 `currentTime` 走** |
| `id` | 轨标识，同时决定 `audio/` 下的文件名 |
| `file` | 相对产物根目录的路径，约定以 `audio/` 开头 |
| `offset` | 该轨相对主时钟的**延迟**（秒）。`1.5` = 主时钟走到 1.5s 时它才从 0 开始 |
| `gain` | 0–2，播放器里的音量滑块初值（`<audio>.volume` 上限 1） |
| `role` | `master` / `overlay`，仅作标注，实际以 `master` 下标为准 |
| `source` | `video`（从源片抽）/ `file`（直接挂现成音频，不重编码） |

### 时钟换算

音频文件从 `from` 秒处起抽，所以 `audio.currentTime = 0` 对应**产物第 0 帧**：

```
frame = clamp(floor((master.currentTime + offsetSec) * fps), 0, frames-1)
```

`offsetSec` 是播放器里的「音画 ±ms」滑块 / `?offset=` 参数，正值把画面往前推。
叠加轨按 `currentTime = masterTime - track.offset` 对齐；拖帧、变速、切后台都
由音频时钟统一驱动，不会像 `performance.now()` 累加那样漂。

### 兼容与降级

- **没有 `audio` 字段**（v1.3 及更早的产物）：播放器完全走旧的画面时钟，零回归。
- `audio.tracks = []`：源片无音轨或抽轨失败，产物静音，仍可用 `attach-audio --file` 后挂。
- 服务端需要给音频文件返回正确 MIME 并支持 **HTTP Range（206）**，否则移动端
  `<audio>` 拖进度会退化成整文件重下。内置 `ascii-full-serve` 已实现；
  用 `python3 -m http.server` 时音频一般也能播，但拖动体验差。
- 终端播放器 `ascii-full-term` 无声（终端本来就没有音频输出），读 `meta.audio`
  时会忽略它，不影响 truecolor 画面。
- iOS / 部分移动浏览器限制同时播放多条 `<audio>`；Android / 桌面浏览器可正常叠加。

### 不重转画面即可改音频

```sh
node bin/attach-audio.js --out DIR --src VIDEO                 # 抽主音轨
node bin/attach-audio.js --out DIR --file bgm.m4a --id bgm --gain .6 --offset 1.5
node bin/attach-audio.js --out DIR --list                     # 列轨
node bin/attach-audio.js --out DIR --master bgm                # 换主时钟
node bin/attach-audio.js --out DIR --remove bgm                # 删轨
```

`attach-audio` 只写 `audio/` 与 `meta.json`；`chunks/`、`frames`、`frameBytes`、
`generatedAt` 一律不动。详见 `docs/AUDIO.md`。

## 最小读取示例（Node）

```js
const M = require('./ascii-out/meta.json');
const zlib = require('zlib'), fs = require('fs');

function frame(f) {
  const n = Math.floor(f / M.chunkFrames);
  const gz = fs.readFileSync(`./ascii-out/chunks/c_${String(n).padStart(5,'0')}.gz`);
  const u8 = zlib.gunzipSync(gz);
  const base = (f % M.chunkFrames) * M.frameBytes;
  return (x, y) => {
    const o = base + (y * M.W + x) * M.bytesPerCell;
    return { ch: M.ramp[u8[o]], r: u8[o+1], g: u8[o+2], b: u8[o+3] };
  };
}
```
