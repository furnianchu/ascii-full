# 色域声明与协商（v1.5）

一句话：**`chunks/` 里那 3 个 RGB 字节一个 bit 都没改**。`meta.color` 只是
旁路的「声明」，由播放端按屏幕能力决定怎么解释 —— 和音频旁路一样，
单独成路、后期好改、不碰画面数据。

## 为什么是「声明」而不是「转换」

ffmpeg 抽 `rgb24` 时已经把 YUV → 8bit/通道 RGB 做完了。转码器拿到的就是
三个 0–255 的数，事后没有任何信息能判断它们当初是按 BT.709 还是 P3 编码的。
所以能做的是：

- 从源片容器里**读标记**（`color_primaries` / `transfer` / `matrix` / `range`），
  如实写进 `meta.color`
- 播放端看屏幕支持什么色域，决定按 P3 呈现、压缩回 sRGB，还是原样 identity

**没有的色不会凭空长出来**。一支 BT.709 / 未标注的 SDR 片，即使放在
Display P3 屏上，`auto` 也只会写 `srgb`，不会偷偷变艳 —— 那不是还原，是染色。

## 命令行参数

```sh
node bin/ascii-full.js --src V.mp4 --out ./ascii-out --gamut auto     # 默认
node bin/ascii-full.js --src V.mp4 --out ./ascii-out --gamut srgb
node bin/ascii-full.js --src V.mp4 --out ./ascii-out --gamut p3
node bin/ascii-full.js --src V.mp4 --out ./ascii-out --gamut expand   # 实验性
```

| 值 | 行为 |
|---|---|
| `auto` | 读 ffprobe 标记；命中 `bt2020 / smpte432 / dci / p3` → `p3`，其余 → `srgb` |
| `srgb` | 手动声明 sRGB，忽略源标记 |
| `p3` | 手动声明 Display P3（源确实是 P3 但没打标记时用） |
| `expand` | 数值仍是 sRGB，但**请求**在 P3 屏按 P3 解释 → 更艳，明确是有意的审美选择，不是还原 |

非法值直接退出并报 `--gamut`，不静默降级。`meta.color` 结构：

```json
"color": {
  "gamut": "srgb",
  "source": "probe",
  "primaries": "bt709",
  "transfer": "bt709",
  "matrix": "bt709",
  "range": "tv",
  "note": "声明式：chunks 里仍是 8bit/通道数值，播放端按屏能力协商解释或降级"
}
```

`source` 取值：`probe`（auto 读出来）/ `flag`（手动指定）/ `expand`。
**老产物没有 `meta.color`** → 按 sRGB 解释，零回归。

## 播放端协商

能力探测要求三者同时成立才认 P3，任何一步异常都按 sRGB 处理、绝不白屏：

```
matchMedia('(color-gamut: p3)')
  && ( CSS.supports('color', 'color(display-p3 1 0 0)')
       || canvas.getContext('2d', {colorSpace:'display-p3'}) )
```

| 数据声明 | 屏幕 | 行为 |
|---|---|---|
| srgb / 老产物 | 任意 | identity，零开销 |
| 真 P3 | P3 | canvas / WebGL drawingBuffer 设 `display-p3`，按 P3 呈现 |
| 真 P3 | sRGB | **线性光 3×3 矩阵**压回 sRGB，不是简单丢标签 |
| `expand` | P3 | 按 P3 解释，饱和度提升（实验性） |
| `expand` | sRGB | identity 原样降级，不二次染色 |

P3→sRGB 走的是线性光域矩阵（先去 gamma → 乘 3×3 → 重新编码），
灰度经矩阵后仍保持中性灰，饱和红也不会溢出 `[0,255]`。
这部分与字形图集共用同一个渲染核心 `web/_render-core.js`，
`player.html` / `standalone.html` 内联的是逐字相同的那一份。

状态栏末尾会显示 `sRGB` / `P3` / `P3→sRGB`。`?nogl=1` 只关 WebGL 字形路径，
**不影响**色域协商。

## 几个容易踩的实话

- **强制 `--gamut p3` 不会提升画质**：源是 SDR 时它只是让颜色偏移/更艳，
  信息量没变。想要真 P3，得从源片就是 P3/杜比视界/HDR 素材开始。
- **8bit/通道是上限**：没有 10bit、没有高位深、没有 HDR 元数据协商。
  这套格式从第一天就是 `1B 索引 + 3×1B RGB`，v1.5 没动它。
- **浏览器一致性**：Chrome / Edge 支持 `color-gamut` 与 `color(display-p3 …)`；
  部分老 WebView 会探测失败并自动按 sRGB 呈现，属于预期降级，不是 bug。
- **电视 / 投屏**：多数电视浏览器报不出 P3，会走降级路径；
  画面和主时钟不受影响。
- **截图**：`截 PNG` 取的是当前 canvas，导出的是屏幕已协商后的颜色，
  不带 ICC/色域标签。

数据布局见 [FORMAT.md](FORMAT.md)，字形表见 [RAMP.md](RAMP.md)。
