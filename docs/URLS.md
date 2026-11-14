# 一条链接就够了

> 给不想碰 HTML 文件的人：产物不该是「两个 .html 让你自己想办法打开」，
> 而应该是**一条能点、能复制、能发给别人的 URL**。

`bin/serve.js` 的根路径 `/` 直接返回播放器，不需要补 `/player.html`。
你之前看到的目录列表来自 `python3 -m http.server`（它没有 index.html 就自动列目录），
不是本项目的服务。

## 1. 本机：一条命令 + 自动拉起浏览器

```sh
node bin/serve.js ./ascii-out 8080 --open
```

`--open` 在 Termux 上调 `termux-open-url`，直接唤起 Edge 并打开
`http://127.0.0.1:8080/`；桌面退回 `open` / `xdg-open` / `start`。

> Termux 需要装 **Termux:API** 这个配套 App 才有 `termux-open-url`。
> 没装也没关系：启动横幅会打印那条链接，Termux 里长按/点击即可，
> 或写进产物目录的 `open.url` 文件里复制到浏览器。

启动横幅长这样：

```
  ── 打开这条链接 ──────────────────────────
  ▸ http://127.0.0.1:8080/
  ──────────────────────────────────────────
  根路径直接进播放器，不用补 /player.html
  Ctrl-C 退出
```

大字用 `--logo "TEXT"` / `--logo-char @` / `--logo-file` 改，`--no-logo` 关掉。
日志照旧写进 `<产物目录>/ascii-full.log`。

## 2. 局域网：同一 WiFi 下用别的设备看

```sh
node bin/serve.js ./ascii-out 8080 --lan --open
```

`--lan` 把监听从 `127.0.0.1` 切到 `0.0.0.0`，并自动枚举 WiFi IP：

```
  ▸ http://127.0.0.1:8080/
    局域网    http://192.168.1.23:8080/
```

手机转码、平板/电脑大屏看，画面不用搬。**公共 WiFi 下别开 `--lan`**，
用完 `Ctrl-C` 关掉。

## 3. 公网域名：串流，不上传

先起服务，再开隧道（两个终端 / 两个 Termux 会话）：

```sh
node bin/serve.js ./ascii-out 8080              # 会话 A，别停
```
```sh
node bin/tunnel.js 8080 --open                 # 会话 B，默认 SSH 反向转发
```

拿到域名会打印并写入 `./tunnel.url`：

```
  ── 公网链接（可直接发给别人）──────────────
  ▸ https://abc123.lhr.life/
  ──────────────────────────────────────────
```

想让 A 的横幅也显示域名，A 那条加 `--public https://abc123.lhr.life`。

**两种 provider**

| | 命令 | 前提 |
|---|---|---|
| SSH（默认） | `--provider ssh` | 22 端口出得去，零安装 |
| Cloudflared | `--provider cloudflared` | 走 443，22 被掐时用；需 `cloudflared` |

Termux 装 cloudflared：先 `pkg install cloudflared`；源里没有就去 Cloudflare
GitHub releases 取 `linux-arm64` 二进制，改名放进 `$PREFIX/bin/` 并 `chmod +x`。

> ⚠ 这是**串流**：手机要一直开机、服务不能停。播放器按 60 帧/块按需取，
> 首次只拉当前那一块（171MB 产物约 2MB/块），不会一次拉全片。
> 想「关掉手机也能看」就得把产物托管到静态站点，那是另一件事，会重新面对体积约束。

### 固定域名（绑自己的域）

```sh
node bin/tunnel.js 8080 --hostname ascii.de5.net
```

打印四步 `cloudflared tunnel login / create / route dns / run`，再：

```sh
node bin/serve.js ./ascii-out 8080 --public https://ascii.de5.net
```

**🚨 必须给这个子域单独放行 Under Attack Mode**（或把 Security Level 降到
Medium 以下）。`fetch('chunks/*.gz')` 不执行 JS，UAM 会静默挡掉请求，
页面表现是白屏、控制台一片干净 —— 跟 `<video src>` 被 UAM 挡是同一个坑。

## 4. 已经有网页？播放器也能直接吃域名

播放器支持 `?src=` 覆盖资源前缀：

```
https://your.site/player.html?src=https://ascii.de5.net/pv/world
```

它会从该前缀拉 `meta.json` 和 `chunks/*.gz`，header 显示「· 远程 <域名>」。
不填 `?src=` 就是同目录，行为与旧版一致。

- **同域**：把 `meta.json` + `chunks/` + `player.html` 一起放站点目录即可，零配置
- **跨域**：对方要给 `.gz` 和 `meta.json` 返回 `Access-Control-Allow-Origin`
- 别忘了 `.gz` **不要**设 `Content-Encoding: gzip`：文件本身已是 gzip 数据，
  播放器用 `DecompressionStream('gzip')` 自己解；服务端再声明一次会双重解压

## 5. 那两个 HTML 还在吗

在，但定位变了：

| 文件 | 给谁 |
|---|---|
| `web/player.html` | **服务端自动提供**，用户不用管它；转码时仍自动复制进产物目录 |
| `web/standalone.html` | 没有命令行、也没人给起服务的人：双击 + 拖入产物目录，`file://` 下用 File API 读 |

自己跑服务的话，两个文件都不用手动打开 🐢
