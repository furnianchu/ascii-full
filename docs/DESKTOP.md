# 桌面版 / 免安装版 / 一键 Release

## 给不碰终端的人：三条路

1. **装桌面版** —— 选视频、点「开始转码」、转完自动弹播放器窗口。
   ffmpeg / ffprobe 已打包进应用，不需要装 Node，也不需要 PATH 里有 ffmpeg。
2. **双击 `standalone.html`** —— 只想看别人转好的产物时，连安装都省了。
   把含 `meta.json` 与 `chunks/` 的文件夹拖进页面即可，全离线。
3. **解压 portable 包** —— 想用命令行但不想配环境：包里自带 Node 运行时、
   ffmpeg、ffprobe、播放器与说明，双击 `start.bat` / `./start.sh` 就能转。

三者读同一份产物，互不冲突。

## 桌面版做了什么

GUI 不是另写一套转码逻辑，而是**同一份 `bin/ascii-full.js` 的图形外壳**：

```
点按钮 → main.js 用 ELECTRON_RUN_AS_NODE=1 让 Electron 自带 Node 执行 CLI
       → stdout/stderr 按行回流到右侧日志面板（启动大字原样显示）
       → 转完起一个仅 127.0.0.1 的临时服务，新开窗口加载 player.html
```

好处是 CLI 加参数、改日志、修 bug，桌面版立即同步，不存在两套行为。
`ffmpeg-static` / `ffprobe-static` 通过 `asarUnpack` 从 asar 里解出来，
再由 `--ffmpeg` / `--ffprobe` 传给 CLI。

界面参数与命令行一一对应：网格行数 / 字符列数（超采样）、帧率、`--interp`、
区间、每块帧数、灰度级数、上下双色、`--force`、启动大字的文字/填充字符/开关，
以及 v1.4 的声音面板。

> 填了「字符列数」就只传 `--cols`、不再传 `--grid` —— 同时给两个会让 CLI
> 认为行数已指定，超采样网格就被压扁。脚本会按源片比例自动反算行数。

### 声音在桌面版怎么走

「③ 声音」勾上后，GUI 给 CLI 追加 `--audio` / `--audio-codec` /
`--audio-bitrate` / `--audio-id`，音轨单独落到产物的 `audio/` 目录，
**不进 `chunks/`**。转完内置服务会把 `audio/` 一起供出去，MIME 与
HTTP Range(206) 和 `bin/serve.js` 是同一套逻辑 —— 不回 206 的话
`<audio>` 拖进度会卡住。

已有产物不想重转画面，用命令行补即可，桌面版不需要额外开关：

```sh
node bin/attach-audio.js --out ./ascii-out --src clip.mp4
node bin/attach-audio.js --out ./ascii-out --file bgm.m4a --id bgm
```

播放器窗口会自动出现「音轨 N」面板，可逐轨调音量、设全局音画偏移。
浏览器拦截无手势有声自动播放时，点一下 `🔇 开声音` 解锁。详见 [AUDIO.md](AUDIO.md)。

## 本地预览

```sh
cd desktop
npm install
npm start              # 开发预览
npm run build          # 出安装包到 ../dist-desktop
```

> Electron 版本写在 `desktop/package.json`，想升级改那一行即可。
> macOS 打 dmg 无需签名（`identity: null`），首次打开可能要在
> 「系统设置 → 隐私与安全性」里点「仍要打开」，属正常现象。

## 一键 Release

```sh
git tag v1.4.0 && git push origin v1.4.0
```

`.github/workflows/release.yml` 三个 job：

| job | 干什么 |
|---|---|
| `desktop` | Windows / macOS / Linux 各自 `npm install && npm run build` |
| `portable` | 四个平台组装免安装包（复制该 runner 的 Node 二进制 + 静态 ffmpeg） |
| `release` | 汇总产物 + `standalone.html` + `SHA256SUMS.txt`，用 `gh release create` 发布 |

`workflow_dispatch` 也能手动触发，但只有 **push tag** 才会真正发布 Release。

`permissions: contents: write` 是 `gh release create` 需要的，别删。

## 免安装包装了什么

```
ascii-full-<平台>/
├ runtime/node(.exe)        ← 从对应 runner 的 process.execPath 复制
├ bin/                      ← CLI + banner.js + logger.js + ffmpeg + ffprobe
├ web/                      ← player.html + standalone.html
├ docs/ README.md LICENSE
├ start.bat / start.sh      ← 转码（已带 --ffmpeg/--ffprobe）
├ play.bat  / play.sh       ← 起服务并自动开浏览器
├ term.bat  / term.sh       ← 纯终端播放
└ 怎么用.txt
```

组装脚本是 `scripts/build-portable.sh`，本地也能直接跑：

```sh
bash scripts/build-portable.sh /tmp/out \
  "$(node -p 'process.execPath')" "$(command -v ffmpeg)" "$(command -v ffprobe)" \
  linux-x64 ''
```

## 发布前两处要手写

- `LICENSE` 里的 `ascii-full contributors`
- 根 `package.json` 的 `repository` / `author` / `bugs`

## 常见状况

- **GUI 报「找不到转码器」** → 打包时 `extraResources` 没带上 `bin/`，
  检查 `desktop/electron-builder.yml` 的 `from: ../bin`。
- **GUI 报 ffmpeg 无法执行** → `asarUnpack` 没生效，或 Linux 上丢了可执行位；
  确认解包出来的 `app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg` 有 `+x`。
- **standalone 双击后拖目录没反应** → 浏览器太旧，需要
  `DecompressionStream`（Chrome 80+ / Firefox 113+ / Safari 16.4+）；
  换新版浏览器，或用 `play.sh` / 桌面版的「打开播放器」。
- **macOS 提示「已损坏」** → 未签名应用的常见提示，
  `xattr -cr /Applications/ascii-full.app` 后再开。
