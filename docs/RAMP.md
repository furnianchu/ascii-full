# 自定义字形表（v1.5）

默认那 70 级 `@%#*+=-:.` 是**经验排序**：谁暗谁亮靠手感。v1.5 允许换成从
真实字体里量出来的表 —— 把每个字按播放时的格子渲染成位图，做一次盒式模糊
（模拟人眼把一格低通掉），再量它平均变多暗，按**分位数**铺满整条灰度轴。
CJK 字库上万个字，中段覆盖率挤得很密，等距切箱会浪费大半级数，所以必须分位数取样。

产物目录里多两个**旁路小文件**：

```
ramp.json        level -> {index, char, coverage} + 图集布局
ramp-atlas.png   预烘焙字形图集，alpha = 模糊后的墨量
```

- 都不进 `chunks/`、不是运行时依赖、不是可执行代码
- 老产物没有 `meta.rampSpec` → 播放器用内置 70 级，零回归
- 一份表喂所有网格密度：字是按 cell 归一化画的，跟 `282×60` / `852×240` 无关

> ⚠️ **实验性，最容易踩的一条**：`chunks/` 里那 1 字节是**转码时那张表的下标**。
> 换表必须重转；重转后 `ramp.json` 与 `ramp-atlas.png` 必须和 `meta.json`
> 放在同一个目录，且必须是转码时用的那一份。表与索引错配的表现是
> 「字符模式全黑、色块正常、`?nogl=1` 正常」—— 排查见
> [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。想稳就别带 `--ramp-file`。

## 1. 生成

```sh
pip install fonttools pillow
python3 scripts/gen-ramp.py --levels 200 --out ./ramp
```

手机（Termux）直接指系统字体，`.ttc` 用 `--font-number` 选第几张脸：

```sh
python3 scripts/gen-ramp.py --font /system/fonts/NotoSansCJK-Regular.ttc \
  --font-number 0 --levels 200 --out ./ramp
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--font` | 自动挑 | `fc-list :lang=zh` 第一个，或常见 Noto / 文泉驿路径 |
| `--font-number` | 0 | `.ttc` 里的字体序号 |
| `--size` | 20 | 渲染字号 |
| `--tile` | 24 | 图集每格边长 px |
| `--cols` | 16 | 图集每行 tile 数 |
| `--levels` | 200 | 级数，**上限 256**（索引是 1 字节） |
| `--limit` | 0 | 只扫前 N 个 cmap 码位，快速试跑用 |
| `--out` | `./ramp` | 输出目录 |

只取 `getBestCmap()` 里字体**真实支持**的码位，不靠 Unicode 区间瞎猜；
控制符、组合符、私用区、未分配一律排除。

**非 BMP 字符（emoji 等）必须排除**：`meta.ramp` 是 JS 字符串，按 UTF-16 单元取值，
一个 emoji 占 2 个单元会把 `ramp[idx]` 整体错位。转码器加载 `--ramp-file` 时会
显式拒绝并报 `UTF-16`，不会悄悄产出坏数据。0 级强制为空格（索引 0 = 不画），
末级取覆盖率最满的字。

## 2. 使用（完整版要重转一次）

```sh
cp ramp/ramp.json ramp/ramp-atlas.png <产物目录>/
node bin/ascii-full.js --src V.mp4 --out <产物目录> --ramp-file ./ramp/ramp.json --force
```

或让转码器自己复制：

```sh
node bin/ascii-full.js --src V.mp4 --out ./ascii-out \
  --ramp-file ./ramp/ramp.json --force
```

**换表必须重转画面**，因为 `chunks/` 里那 1 字节索引是按 `len(ramp)` 重新量化的：

```
idx = clamp(floor(lum / 256 * N), 0, N-1)
```

70 级换 200 级后，旧帧的索引值语义就变了，不重转等于拿旧表查新字。
代价只是重跑一次转码，`4B/cell` 布局、`frameBytes`、音频旁路、
`meta.audio.tracks[]` 全部不动 —— 和「单独成路后期好改」是同一套思路。
`--force` 会同步覆盖产物目录里的 `ramp.json` / `ramp-atlas.png`，避免名字没变
内容却对不上。把两个文件**直接解压进产物目录**、再拿它当 `--ramp-file` 也安全：
转码器会在 `--force` 清理前把源文件读进内存、清理后写回，不会自删，
也不会触发同路径 `copyFileSync` 失败。

`meta.ramp` 变成新表字符串，`meta.rampSpec` 记下图集布局与生成方式：

```json
"rampSpec": {
  "version": 2,
  "generator": "ascii-full/scripts/gen-ramp.py",
  "font": "NotoSansCJK-Regular.ttc",
  "method": "rendered-ink-coverage / box-blur / quantile bins",
  "levels": [{ "index": 0, "char": " ", "coverage": 0.0 }],
  "atlas": { "file": "ramp-atlas.png", "tileW": 24, "tileH": 24,
             "cols": 16, "rows": 13, "count": 200, "channel": "alpha" }
}
```

本机绝对路径不写进 meta。

## 3. 播放端：一次 draw call

字形不再逐个 `fillText`，而是预烘焙进图集纹理：每帧只上传「索引」和「RGB」
两张 `W×H` 小纹理，fragment shader 按索引采样图集 alpha，一次 `drawArrays`
画完整帧。这同时解决了两件事：

- **字符 0.9 fps 那道坎**：调用次数从 5 万降到 1
- **CJK 双宽串格**：字是按 tile 归一化画进图集，不看字体 advance

启用条件：`plain`（非 `--half`）+ `meta.rampSpec.atlas` 存在 + WebGL 可用。
以下情形一律**回退 2D 路径**，绝不白屏：

- `?nogl=1` 手动关
- 老电视 / 老 WebView 没有 WebGL
- `--half` 双色模式
- 没有自定义表（内置 70 级仍走按颜色分组的 `fillText`）

状态栏会显示当前是 `GL字形` / `2D字符` / `色块`。

## 4. 边界与实话

- **索引 1 字节 = 256 级硬顶**。200 级是「同一把尺刻更细」，不是颜色变多；
  颜色始终由另外 3 个独立 RGB 字节给，两条轴正交。
- 换表**不改善源片信息量**。720p 压制片堆到 200 级，只是笔画层次更细，
  不会把压缩块还原成细节。
- 覆盖率是「渲染后平均暗度」的近似，不完全等于视觉重量：笔画粗细、
  内白、字重都会影响观感。分位数分箱 + 强制两端是缓解，不是物理测量。
- 图集是**产物的一部分**，要和 `chunks/` 一起带着走；只拷 `meta.json`
  会静默降级回内置表（能播，但不是你挑的那些字）。
- `gen-ramp.py` 只在**生成时**要 fontTools + Pillow；转码器与播放器依旧零
  npm 运行时依赖。

格式细节见 [FORMAT.md](FORMAT.md)，色域见 [COLOR.md](COLOR.md)。
