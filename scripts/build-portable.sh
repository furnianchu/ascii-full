#!/usr/bin/env bash
# 组装「免安装终端版」：解压/双击即用，不需要 npm、不需要系统 ffmpeg。
#
#   bash scripts/build-portable.sh <OUT> <NODE_BIN> <FFMPEG> <FFPROBE> <PLATFORM> [EXE_EXT]
#
# 由 .github/workflows/release.yml 在各平台 runner 上调用；本地也能跑。
# NODE_BIN 用 `node -p process.execPath` 取，保证和 runner 架构一致。
set -euo pipefail

OUT="${1:?OUT}"; NODE="${2:?NODE}"; FFMPEG="${3:?FFMPEG}"; FFPROBE="${4:?FFPROBE}"
PLATFORM="${5:?PLATFORM}"; EXT="${6:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

rm -rf "$OUT"
mkdir -p "$OUT/runtime" "$OUT/bin" "$OUT/web" "$OUT/docs"

cp -a "$ROOT/bin/."          "$OUT/bin/"
cp -a "$ROOT/web/."          "$OUT/web/"
cp -a "$ROOT/docs/."         "$OUT/docs/"
cp "$ROOT/README.md"         "$OUT/README.md"
cp "$ROOT/LICENSE"           "$OUT/LICENSE"
cp "$ROOT/package.json"      "$OUT/package.json"

cp "$NODE"   "$OUT/runtime/node${EXT}"
cp "$FFMPEG" "$OUT/bin/ffmpeg${EXT}"
cp "$FFPROBE" "$OUT/bin/ffprobe${EXT}"

if [[ "$PLATFORM" == win-* ]]; then
  cat > "$OUT/start.bat" <<'EOF'
@echo off
setlocal
set HERE=%~dp0
"%HERE%runtime\node.exe" "%HERE%bin\ascii-full.js" --ffmpeg "%HERE%bin\ffmpeg.exe" --ffprobe "%HERE%bin\ffprobe.exe" %*
EOF
  cat > "$OUT/play.bat" <<'EOF'
@echo off
setlocal
set HERE=%~dp0
"%HERE%runtime\node.exe" "%HERE%bin\serve.js" %* --open
EOF
  cat > "$OUT/term.bat" <<'EOF'
@echo off
setlocal
set HERE=%~dp0
"%HERE%runtime\node.exe" "%HERE%bin\ascii-full-term.js" %*
EOF
else
  cat > "$OUT/start.sh" <<'EOF'
#!/usr/bin/env sh
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$HERE/runtime/node" "$HERE/bin/ascii-full.js" \
  --ffmpeg "$HERE/bin/ffmpeg" --ffprobe "$HERE/bin/ffprobe" "$@"
EOF
  cat > "$OUT/play.sh" <<'EOF'
#!/usr/bin/env sh
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$HERE/runtime/node" "$HERE/bin/serve.js" "$@" --open
EOF
  cat > "$OUT/term.sh" <<'EOF'
#!/usr/bin/env sh
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$HERE/runtime/node" "$HERE/bin/ascii-full-term.js" "$@"
EOF
  chmod +x "$OUT/start.sh" "$OUT/play.sh" "$OUT/term.sh" \
           "$OUT/runtime/node" "$OUT/bin/ffmpeg" "$OUT/bin/ffprobe"
fi

cat > "$OUT/怎么用.txt" <<'EOF'
ascii-full · 免安装终端版
========================

不需要装 Node，也不需要装 ffmpeg —— 都在这个文件夹里了。

【最省事】
  直接双击 web/standalone.html（浏览器打开），把产物目录拖进去就能看。
  这一步连终端都不用开。

【想自己转视频】
  Windows : start.bat --src "C:\path\clip.mp4" --out "C:\path\out"
  macOS/Linux : ./start.sh --src ./clip.mp4 --out ./out

  常用参数：
    --grid 60      字符行数（45 轻 / 60 标准 / 90 狠）
    --half         ▀ 上下双色，垂直分辨率翻倍
    --to 3         只转前 3 秒先试一下
    --force        产物已存在时重跑
    --logo "HELLO" 启动时打印自定义 ASCII 大字
    --logo-file f  用现成的 ASCII art 文件当大字
    --quiet        只留进度与汇总，日志仍写到 <输出目录>/ascii-full.log

【转完怎么看】
  Windows : play.bat "输出目录"
  macOS/Linux : ./play.sh "输出目录"
  会自动开浏览器。也可以双击 web/standalone.html 拖入目录。

  纯终端播放（需 truecolor 终端）：
    Windows : term.bat "输出目录"
    macOS/Linux : ./term.sh "输出目录"

【想要图形界面】
  去 Release 下载 ascii-full-desktop-* 安装包，选文件点一下就行。

日志默认落在「输出目录/ascii-full.log」，出错时把这份文件贴出来最好排查。
EOF

echo "✓ portable 组装完成: $OUT"
find "$OUT" -maxdepth 2 -type f | sort
