# 更新日志

## v1.6.0 — 导出宣传片（数据 → 普通 mp4）

**新增**

- `ascii-full-export` / `bin/export-video.js`：把产物渲染成 H.264 + yuv420p + AAC +
  faststart + BT.709 标记的常规 mp4，直接传视频网站，观众零门槛
- 两步流程明确写进文档：`源片 → 字符画数据 → 字符画风格视频`。第 ② 步**不重新取色、
  不二次转码**，`1B 索引 + 3B RGB` 原样画成像素，相对 chunks 零损失
- `--from` / `--duration` 按产物帧轴截取，只 gunzip 覆盖到的那几个块，不必铺开全量数据
- `--mode glyph|block`、`--glyph auto|atlas|font|dither`、`--scale 1~4`（nearest）、
  `--font`、`--crf`、`--preset`、`--no-audio`
- 字形图集三级兜底：产物自带 `ramp-atlas.png`（自写零依赖 PNG 解码，取 alpha 墨量）
  → ffmpeg drawtext 逐字 `textfile` 渲染（绕开特殊字符转义）→ Bayer 覆盖率网点
- **每条来源先验墨量**，几乎无墨即降级并明确告警 —— 不产出全黑视频（实测四种来源
  抽帧非黑像素 37.8%~50.0%）
- 多轨按各自 `gain / offset` 经 `atrim / volume / adelay / amix(normalize=0)` 混成
  一条 AAC 192k；`--half` 上下双色分支同样支持
- 中文文档 `docs/EXPORT.md`；README 补「⑥ 导出宣传片」全量参数表与两步流程图
- 端到端自检验编码、帧数、音频轨、`faststart` 与**抽帧非黑**（不拿 mock 结果当真机验收）

**实话与边界**

- mp4 是快照：不能拖密度、不能切字形/色块、不能单独挂音轨；这些能力只在本地 chunks 里
- H.264 编码走 CPU，计算卡没有 NVENC 是正常现象
- `meta.color.gamut=p3` 是声明式旁路，导出统一按 BT.709 标记，不凭空变艳
- 想做「字符叠字符」套娃，把导出的 mp4 当源片再转一次即可，但会二次采样，只建议几秒

## v1.5.0 — 字形表与色域，各自单独成路

> 文案修订：界面显示名定为「ascii字符画视频」，README 与全部介绍文档改为中文，
> 补全五个命令与播放器地址的参数表；功能代码与本次修订前一致。
> 另标注 `--ramp-file` 为实验性：表 / 图集必须与产物同目录，换表必须重转。

上一版把声音拆成旁路；这一版把「字形」和「色域」也拆成旁路。
`chunks/` 仍是 `1B 索引 + 3B RGB`，一个字节没动。

**新增**

- `--ramp-file ramp.json`：加载自定义字形表，索引按新级数重新量化
- `scripts/gen-ramp.py`：从字体 `cmap` 取真实支持字 → 渲染成 cell 位图 →
  盒式模糊算平均暗度 → 分位数分箱 → 出 `ramp.json` + `ramp-atlas.png`
- 非 BMP（emoji）字形、越界级数、非法级数一律拒绝，不悄悄产出坏数据
- `--gamut auto|srgb|p3|expand`：`auto` 读 ffprobe 色域标记，BT.709 / 未标注
  的 SDR 片如实写 `srgb`，不凭空变艳；`expand` 明确标为实验性
- `meta.color` / `meta.rampSpec` 两个旁路字段；老产物无字段时零回归
- 渲染核心 `web/_render-core.js`：`scripts/inline-core.js` 把它逐字内联进
  两个播放器，杜绝「命令行改了、图形界面 / 单文件漏同步」
- `GlyphGL`：字形图集 + 索引/RGB 三纹理，一次 draw call 画完整帧；
  `?nogl=1` / 无 WebGL / `--half` / 无图集一律回退 2D
- 色域协商：P3 屏按 `display-p3` 呈现，sRGB 屏走线性光 3×3 矩阵压缩，
  `expand` 在 sRGB 屏原样降级不二次染色；状态栏显示 `sRGB / P3 / P3→sRGB`
- 桌面 GUI 同步「④ 字形 / 色域」面板；`docs/RAMP.md` / `docs/COLOR.md`
- `--ramp-file` 与 `--out` 同目录时，`--force` 先把两个旁路文件读进内存再清理、
  之后写回，不会自删源文件 / 同路径复制失败（已固化成断言）
- 测试：`core.test.js` 覆盖色域计划、矩阵中性灰、ramp 解析、shader 结构
  与 mock WebGL 的一次 draw call；`render.test.js` 沙箱补齐 1.5 全局量，
  继续保证 2D 逐像素等价

**实话与边界**

- 1 字节索引 = **256 级硬顶**；200 级是同一把尺刻更细，不是颜色变多
- 换表要重转画面（索引语义变了），但音频旁路、`frameBytes`、格式全不动
- 源片是 SDR 时强制 `p3` / `expand` 不会增加信息量，只是偏移或更艳
- 图集是产物的一部分，要和 `chunks/` 一起带走；只拷 `meta.json` 会静默降级

## v1.4.0 — 声音单独成一路

之前整条管线只取 `v:0`，音轨从来没进过格式。现在画面与声音彻底拆成两条路，
`chunks/` 只管画，`audio/` 只管声，`meta.audio.tracks[]` 关联。

**新增**

- `--audio` / `--audio-codec opus|mp3|pcm` / `--audio-bitrate` / `--audio-id`
- `bin/attach-audio.js`：从视频抽轨、直接挂现成音频、`--list` / `--remove` / `--master` / `--replace`
- `meta.audio = { version, master, tracks[] }`；每条轨带 `gain / offset / role / source`
- 播放器：多条 `<audio>`、主时钟算帧、`音轨 N` 面板逐轨音量、`音画 ±ms`、`?mute=1` / `?offset=`
- 静态服务：音频 MIME + HTTP Range(206) + `Accept-Ranges`
- 文档：`docs/AUDIO.md`；`FORMAT.md` 补 `audio.tracks[]` 与时钟换算
- `--force` 重转画面时继承 `source:'file'` 的外部音轨，不删播放器
- 桌面 GUI 同步：③ 声音面板、超采样列数、`--interp`；内置服务补音频 MIME 与 Range(206)，
  与 `bin/serve.js` 同一套逻辑（`<audio>` 不回 206 会拖不动进度）
- `attach-audio` 写 meta 时自动把 v1.3 老播放器升级成支持音频的版本；已是新版则不覆盖
- `npm test` 156 项断言，新增「命令行参数 ↔ 桌面图形界面」静态同步检查，防止再次漏同步

**兼容**

- 默认不抽音轨，老命令输出与 v1.3 逐字节一致
- 没有 `meta.audio` 的老产物：播放器走旧 `performance.now()` 时钟，零回归
- 终端播放器读 `meta.audio` 时忽略它（终端无音频输出）

## v1.3.0 — 入口改成一条 URL

根路径直出播放器、`--open` 走 `termux-open-url`、`--lan` 枚举局域网 IP、
`ascii-full-tunnel` 出临时 https 域名、`--hostname` 绑固定域、播放器支持 `?src=`。

## v1.2.1 — 渲染帧率

亮度查表、色块走 `ImageData`、字符按颜色分组、状态栏显示真实渲染 fps；
新增 `--interp` 运动补偿插帧。

## v1.2.0 — 大画布与超采样

默认按 8×16 px/字符出真实画布、0.5×~8× 缩放、拖动平移、双指 pinch、
亮度滑块；转码器新增 `--cols` 超采样。

## v1.1.0 — 四种形态

桌面图形版、零安装单文件、免安装终端版、命令行；一键发布流水线；
启动 ASCII 大字与结构化日志落盘。

## v1.0.0

首个可发布版本：离线全帧率真彩转码、按块 gzip、浏览器/终端播放器、数据格式文档。
