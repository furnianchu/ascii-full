# 排错

## `✗ 无法执行 ffmpeg` / 明明装了却报缺失

先确认：

```sh
command -v ffmpeg && ffmpeg -version | head -1
```

如果这条有输出，那就是环境问题而非缺包。转码器**直接执行** `ffmpeg -version` 来探测，
刻意不用 `which` —— 精简环境（Termux / 最小容器）可能没有 `which` 这个可执行文件，
`spawnSync` 找不到它时 `status=null`，旧逻辑会把它误判成「ffmpeg 没装」。

安装方式：

| 平台 | 命令 |
|---|---|
| Termux / Android | `pkg install ffmpeg` |
| macOS | `brew install ffmpeg` |
| Debian / Ubuntu | `sudo apt install ffmpeg` |
| Windows | 下载 ffmpeg 并把 `bin/` 加进 PATH |

## `GET /player.html 404`，但 `meta.json` / `chunks/*.gz` 都 200

服务起在**产物目录**，而播放器源文件在仓库的 `web/` 下。转码结束时会自动复制一份
（汇总里会打印 `播放器: 已自动放入输出目录 ✓`），若你用的是旧版或手工搬过目录，补一条：

```sh
cp web/player.html <产物目录>/player.html
```

`GET /favicon.ico 404` 是浏览器自动要站点图标，**无害**。

## 打开 `file://…/player.html` 一片空白

浏览器不允许 `file://` 页面 fetch 同目录的 `.gz`。必须走 HTTP：

```sh
ascii-full-serve ./ascii-out
# 或: cd ascii-out && python3 -m http.server 8080
```

然后开 `http://localhost:8080/player.html`。

## 终端里播会折行 / 颜色不对

`ascii-full-term` 需要：

- `$COLORTERM=truecolor`（24-bit 色）
- 终端列数 ≥ `meta.W`（默认网格宽度 200~400），行数 ≥ `meta.H`

手机竖屏基本不够。用 `--grid 30` 转一份小网格，或改用浏览器播放器（canvas 自适应缩放）。
Ctrl-C 会恢复光标并重置颜色。

## 画面一片暗糊、字符小得看不清

**先别重转，多半是显示尺寸问题。** 早期播放器把 `W` 列强行压进屏幕宽度，
手机竖屏上 213 列 → 每字符约 2px 宽、字号 3.7px，字形根本画不出来，只剩一片暗点。
源片是 4K 也好、2K 也好，转出来的数据没丢，只是没地方显示。

按顺序试：

1. 点 `＋` 放大（0.5×~8×），或 `100%` 回到每字符 8px 基准；画布会真实变大，
   **拖动画布**看局部、双指 pinch 也能缩放
2. 拉「亮度」滑块 —— 夜景 / 聊天窗口这类暗片，颜色常挤在 ramp 前几级，提亮后层次才出来
3. 想一眼看全幅再点「适应」（会缩回屏宽，糊是正常的，它只是全览）
4. 放大后仍觉得**一个采样点只有一个字符太粗**，才需要重转高密度网格：`--cols 426`
   （2× 密度 / 4× 字符数）或 `--cols 852`（4× 密度 / **16× 字符数**）。
   体积按字符数同比放大，务必先看 `--help` 里的档位表留够硬盘

`截 PNG` 导出的是当前缩放后的整张画布，放大后截能拿到更清晰的一帧。

## 产物太大

体积 ≈ `帧数 × W × H × bytesPerCell`（gzip 后通常为原始的 1/5 ~ 1/2.5）。
三个旋钮，按代价从小到大：

1. `--grid 45` → 行数 60→45，面积约降到 56%
2. `--fps 15` → 帧数减半（会丢帧，但很多字符画场景看不出）
3. `--chunk 120` → 只影响块数量，**不减小体积**，但减少文件数

`--half` 会把每 cell 从 4 B 涨到 7 B，慎用。
`--force` 只清 `chunks/` 和 `meta.json`，不会删你放进产物目录的其他文件。

## 状态栏「N 块缓存」看着不降，是不是没在清理？

在清，只是平时**攒不到上限**。播放器预取下一块，顺序播放时内存里常驻 2~3 块，
而上限是浏览器 6 块 / 终端 5 块 —— 阈值没触发，自然看不到淘汰动作。
来回拖帧才会涨到上限，这时状态栏会稳定在 `6/6`（或 `5/5`），多出来的最旧块被丢掉。

两个可调开关：`player.html?cache=12` / `ascii-full-term --cache 10`。

如果看到的是**磁盘空间一直不释放**：那是刻意的，`chunks/*.gz` 是产物不是缓存，
不会自动删。重跑加 `--force`，或换 `--out`。

## 双击 standalone.html 拖目录没反应

先确认浏览器够新：`DecompressionStream` 需要 Chrome 80+ / Firefox 113+ / Safari 16.4+。
页面会在错误区明确提示。其次确认拖进来的是**整个产物目录**（里面同时有
`meta.json` 和 `chunks/`）；只拖 `meta.json` 会提示补选 chunks。

它是用 File API 读用户主动选择的文件，不走 fetch，所以 `file://` 下完全可用，
不存在的「CORS 被拦」在这里不会发生。

## 桌面版报「找不到转码器」/ ffmpeg 无法执行

- 找不到 `bin/ascii-full.js` → 打包配置的 `extraResources` 没带上 `bin/`
- ffmpeg 起不来 → `asarUnpack` 没把二进制从 asar 里解出来，或 Linux 上丢了 `+x`

对应配置在 `desktop/electron-builder.yml`。本地预览（不打包）时走仓库里的
`bin/` 与 PATH 上的 ffmpeg，不会遇到这两个问题。

## `✗ 已存在 meta.json`

防误覆盖的设计。确认重跑就加 `--force`，或换一个 `--out` 目录。
中断后重跑用同一条命令即可，`--force` 会从第 0 帧重新开始（不做断点续传）。


## 感觉帧率很低 / 画面一顿一顿

先分清是**数据帧率**还是**渲染帧率**。播放器状态栏现在会显示
`渲染 14.2/24fps` —— 前者是实际画出来的帧率，后者是 `meta.json` 里的 fps。

**数据侧**：默认取源片原生帧率，不丢帧。用 `node -e "console.log(require('./meta.json').fps)"`
或直接看汇总里的「帧数 / 秒」。若源片本身是 24fps，那信息上限就是 24fps。

**渲染侧（最常见）**：高密度网格下每帧有几万个 cell。v1.2.0 及以前每 cell 都做
3 次 `Math.pow` + 拼 `rgb()` 字符串 + 设 `fillStyle` + `fillText`，光 JS 层在
426×120 网格上就约 18ms/帧，加上 canvas 调用远超 24fps 的 41.7ms 预算 →
数据一帧没少，肉眼却只有十来帧。

v1.2.1 起的三处优化：

- 亮度增益改成 256 项查表，去掉逐 cell 的 `Math.pow`
- **色块模式**走 `ImageData`：整帧只做 1 次 `putImageData` + 1 次 `drawImage`
- **字符模式**按颜色分组，一组只设一次 `fillStyle`，`ramp[0]` 空格直接跳过
- `tick` 默认**不追帧**（均匀慢放而非跳帧）；点「追帧」按钮可切回按时间轴跳帧

所以若状态栏显示 `渲染 12/24fps`，先试「色块」按钮，或降低 `--cols` 档位。

**想真的高于源片帧率**：

```sh
ascii-full --src V.mp4 --fps 48              # 复制帧填充，不增加信息
ascii-full --src V.mp4 --fps 48 --interp     # minterpolate 运动补偿插帧
```

`--interp` 在缩放后的字符网格上跑（小网格会先等比放大到 ≥64 再缩回，
因为 minterpolate 硬性要求输入 ≥32×32）。它是**造出来的中间帧**，不是源片信息；
ASCII 是离散色块，快速运动处可能有鬼影，属于实验性选项。插帧后尾部帧数可能
比理论值少几帧（运动补偿需要前后参考帧），属正常。

网站部署版如果看着卡，检查转码侧的 fps 参数与播放器读取的帧率是否一致 ——
只改一边会让时间轴串台。
