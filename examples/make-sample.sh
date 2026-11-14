#!/usr/bin/env bash
# 生成一段 2 秒彩色测试片，没有素材也能立刻试跑。
# 用法: bash examples/make-sample.sh [输出文件]
set -euo pipefail

OUT="${1:-sample.mp4}"

ffmpeg -v error -f lavfi \
  -i "testsrc2=size=640x360:rate=24:duration=2" \
  -f lavfi -i "sine=frequency=440:duration=2" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest -y "$OUT"

echo "✓ 已生成 $OUT"
echo "  试跑: ascii-full --src $OUT --out ./ascii-out --grid 45 --to 2 --force"
echo "  播放: ascii-full-serve ./ascii-out"
