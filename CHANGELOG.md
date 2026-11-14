# Changelog

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
- `npm test` 156 项断言，新增「CLI 参数 ↔ 桌面 GUI」静态同步检查，防止再次漏同步

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

桌面图形版、零安装单文件、免安装 portable、CLI；Release 流水线；
启动 ASCII 大字与结构化日志落盘。

## v1.0.0

首个可发布版本：离线全帧率真彩转码、按块 gzip、浏览器/终端播放器、数据格式文档。
