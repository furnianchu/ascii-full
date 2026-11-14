# 数据格式 v1

产物是**纯数据**，不含可执行代码、不含服务端逻辑：

```
ascii-out/
├── meta.json          # 描述文件（UTF-8 JSON）
├── player.html        # 转码时自动复制进来的浏览器播放器
└── chunks/
    ├── c_00000.gz
    ├── c_00001.gz
    └── ...
```

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
