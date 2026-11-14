# 音频：旁路、可叠加、可不重转

> v1.4 之前整条管线只取 `v:0`，音轨从进 ffmpeg 那一刻就被丢了 —— 不是静音开关，
> 是**声音从来没进过格式**。v1.4 把声音单独成一路：画面继续待在 `chunks/`，
> 声音待在 `audio/`，两者只靠 `meta.audio.tracks[]` 关联。

## 为什么是「一路」

```
meta.json
├── chunks/*.gz   ← 画面（几百 MB ~ 几 GB，最贵，最不想重算）
└── audio/*.webm  ← 声音（1~2 MB，随便改）
```

抽音轨、换编码、叠 BGM、加解说、换语种、调音量、调延迟 —— **全都只动 `audio/` + `meta.json`**，
帧数据一个字节不动。这也是把它做成 `tracks[]` 数组而不是单个 `audio.webm` 的原因：
加一路 = 往数组里追加一项，格式不用升级。

## 三种起点

### ① 转码时一次带上（新产物）

```sh
node bin/ascii-full.js --src VIDEO.mp4 --out out --cols 426 --audio --force
```

产物多出 `audio/main.webm`（Opus 48k，约 1~2 MB / 3.5 分钟）。
`--audio-codec mp3|pcm`、`--audio-bitrate 96k`、`--audio-id main` 可调。

### ② 已有产物补音轨（不重转画面）

你那份 171.5 MB / 5085 帧的产物不用动：

```sh
node bin/attach-audio.js --src VIDEO.mp4 --out ~/world-ascii --id main
```

`attach-audio` 会读 `meta.from / meta.to`，抽出的音频区间和画面严格一致，
然后只写 `audio/main.webm` 与 `meta.json`。**耗时一两秒，不碰 chunks。**

如果产物目录里还是 v1.3 及更早的播放器（不认识 `meta.audio`），脚本会
自动把它换成新版 —— 否则会出现「文件都在、就是没声音」。已是新版则不覆盖，
放自定义播放器也没问题。

### ③ 用现成音频文件直接挂（BGM / 解说 / 多语种）

```sh
node bin/attach-audio.js --out ~/world-ascii --file bgm.m4a --id bgm --gain 0.6 --offset 1.5
node bin/attach-audio.js --out ~/world-ascii --file voice_ja.wav --id ja --gain 1
```

`--file` **不重编码**，原样复制，适合本来就是独立音频的素材。

## 多轨叠加

```sh
node bin/attach-audio.js --out out --list
node bin/attach-audio.js --out out --master bgm        # 换主时钟
node bin/attach-audio.js --out out --remove bgm        # 删一条（连文件）
```

| 参数 | 作用 |
|---|---|
| `--gain 0~2` | 该轨音量，播放器里也有滑块可实时拖 |
| `--offset S` | 该轨相对主时钟**延迟**多少秒。`1.5` = 主时钟走到 1.5s 时它才从 0 开始 |
| `--role master` | 新增轨直接当主时钟 |
| `--replace` | 同 id 覆盖，而不是自动顺延成 `track2` |

播放器底部「**音轨 N**」面板里，每条轨有独立音量滑块和静音按钮，
`★` 标出主时钟。`音画 ±ms` 滑块是全局微调（也可 `?offset=-120`），
正值把画面往前推 —— 不同浏览器解码延迟不一样，留个手调口子。

## 同步怎么做的

有音轨时播放器**丢掉 `performance.now()` 自数的时间轴**，改由主时钟轨的
`currentTime` 直接算帧：

```
frame = clamp(floor((master.currentTime + offsetSec) * fps), 0, frames-1)
```

所以切后台、掉帧、解码抖动、2×/4× 变速都不会让音画错位 —— 它们本来就是同一个钟。
`?src=https://域名/路径/` 远程播放时同样成立，音频走普通 HTTP 请求。

**没有 `meta.audio` 的老产物**：完全走旧画面时钟，零回归，不会白屏。

## 浏览器与服务的几个事实

- **自动播放**：浏览器普遍拦截「无手势的有声播放」。播放器会先试有声，
  被拦就自动降级成静音继续放画面，并把按钮变成 `🔇 开声音` —— **点一下解锁**。
  想一开始静音用 `?mute=1`；键盘 `M` 也能切。
- **Range**：`<audio>` 拖进度会发 `Range: bytes=…`。内置 `ascii-full-serve`
  返回 206 + `Content-Range` + 正确 MIME；`python3 -m http.server` 通常也能播，
  但拖动体验差，建议用内置服务。
- **域名 / 隧道**：`ascii-full-tunnel` 串流时音频一起走 HTTPS。若绑到
  `de5.net` 这类开了 **Under Attack Mode** 的域名，记得给 `audio/` 单独放行 ——
  `fetch` 与 `<audio>` 都不执行 JS，会被挑战页静默挡掉，表现是画面有、声音没。
- **终端播放器无声**：`ascii-full-term` 读 `meta.audio` 会忽略它，终端本来也没有音频输出。
- **iOS** 限制同时播放多条 `<audio>`；Android / 桌面浏览器可正常叠加。

## `--force` 重转画面时

只删 `source: 'video'`（转码器自己抽的）音轨；`attach-audio --file`
挂进来的外部音轨会被**原样继承**到新 `meta.json`，不用重新挂一遍。
这是按 `source` 字段区分的，别手改这个值。

## 体积参考

Opus 48k 单声道约 **0.4 MB/分钟**，211.9 秒 ≈ 1.4 MB；相对 171.5 MB 的画面
几乎可以忽略。PCM (`--codec pcm`) 是无损但大约 2.6 MB/分钟，本地收藏用得上，
托管到公网就没必要了。
