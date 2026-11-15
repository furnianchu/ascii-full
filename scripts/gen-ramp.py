#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ascii-full · 离线字形覆盖率表生成器（v1.5.0）

思路不是「谁笔画多谁更暗」的经验排序，而是把每个字按播放时的格子渲染成
位图，做一次盒式模糊（模拟人眼把一格低通掉），再量它平均变多暗。
然后按 **分位数** 分箱成 N 级 —— CJK 覆盖率高度挤在中段，等距切会浪费。

产出两个旁路小文件，直接放进产物目录即可，不进 chunks、不是运行时依赖：

    ramp.json        level -> {char, coverage, index}
    ramp-atlas.png   预烘焙字形图集，alpha = 墨量

用法（电脑 / Termux 都行，需要 fontTools + Pillow）：
    pip install fonttools pillow
    python3 scripts/gen-ramp.py --levels 200 --out ./ramp
    cp ramp/ramp.json ramp/ramp-atlas.png <产物目录>/
    node bin/ascii-full.js --src V --out DIR --ramp-file ./ramp/ramp.json --force

字体不给就自动挑系统里第一个中文字体；手机可直接指字体文件：
    python3 scripts/gen-ramp.py --font /system/fonts/NotoSansCJK-Regular.ttc
"""
import argparse
import json
import math
import os
import subprocess
import sys

try:
    from PIL import Image, ImageDraw, ImageFont, ImageFilter
    from fontTools.ttLib import TTFont, TTCollection
except ImportError as e:
    sys.exit("缺依赖：pip install fonttools pillow\n原始错误: %s" % e)


def pick_font(explicit=None, font_number=0):
    if explicit:
        return explicit
    try:
        out = subprocess.check_output(["fc-list", ":lang=zh", "file"], text=True)
        for line in out.splitlines():
            p = line.split(":", 1)[0].strip()
            if p and os.path.exists(p):
                return p
    except Exception:
        pass
    for p in ("/system/fonts/NotoSansCJK-Regular.ttc",
              "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
              "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"):
        if os.path.exists(p):
            return p
    sys.exit("找不到中文字体，用 --font 指一个 .ttf/.ttc/.otf")


def supported_chars(font_path, font_number):
    """只取字体真实 cmap 里的码位，不靠 Unicode 区间瞎猜。"""
    if font_path.lower().endswith(".ttc"):
        coll = TTCollection(font_path)
        f = coll.fonts[font_number] if font_number < len(coll.fonts) else coll.fonts[0]
    else:
        f = TTFont(font_path, fontNumber=font_number)
    cmap = f.getBestCmap() or {}
    out = []
    for cp in sorted(cmap):
        ch = chr(cp)
        cat = __import__("unicodedata").category(ch)
        # 排除控制符、组合符、代理区、私用区、未分配；emoji 与彩色字体另说
        if cat.startswith("C") or cat.startswith("M") or cat == "Zl" or cat == "Zp":
            continue
        # 索引是 1 字节，meta.ramp 按 UTF-16 单元取值：非 BMP（emoji 等）
        # 一个字占 2 单元，会把 ramp[idx] 整体错位，必须排除。
        if 0xE000 <= cp <= 0xF8FF or cp > 0xFFFF:
            continue
        if ch.isspace() and ch not in (" ", "\u3000"):
            continue
        out.append(ch)
    return out


def measure(font, ch, tile_w, tile_h):
    """渲染后做一次盒式模糊，返回平均暗度 coverage ∈ [0,1]。"""
    im = Image.new("L", (tile_w, tile_h), 0)
    d = ImageDraw.Draw(im)
    # 不依赖字体的 advance：强制居中画进一个格子，CJK 双宽也不会串格
    try:
        box = d.textbbox((0, 0), ch, font=font)
        w, h = box[2] - box[0], box[3] - box[1]
        x = (tile_w - w) / 2 - box[0]
        y = (tile_h - h) / 2 - box[1]
        d.text((x, y), ch, font=font, fill=255)
    except Exception:
        return 0.0
    im = im.filter(ImageFilter.BoxBlur(1))
    hist = im.histogram()
    total = sum(i * hist[i] for i in range(256)) / (tile_w * tile_h * 255)
    return round(min(1.0, max(0.0, total)), 6)


def build(args):
    font_path = pick_font(args.font, args.font_number)
    tile_w, tile_h = args.tile, args.tile
    try:
        pil_font = ImageFont.truetype(font_path, args.size,
                                      index=args.font_number if font_path.lower().endswith(".ttc") else 0)
    except Exception as e:
        sys.exit("打不开字体 %s: %s" % (font_path, e))

    chars = supported_chars(font_path, args.font_number)
    if args.limit:
        chars = chars[: args.limit]
    print("字体: %s" % font_path)
    print("cmap 候选: %d 字" % len(chars))

    scored = []
    for ch in chars:
        scored.append((measure(pil_font, ch, tile_w, tile_h), ch))
    scored.sort(key=lambda t: (t[0], t[1]))

    # 按分位数取样：中段密、两端稀的字库也能均匀铺满整个灰度轴
    n = min(256, max(2, args.levels))
    picked = []
    for k in range(n):
        pos = round(k * (len(scored) - 1) / (n - 1))
        picked.append(scored[pos])
    # 去重复字（覆盖率相近时分位数可能撞车），用邻位补
    seen, uniq = set(), []
    for cov, ch in picked:
        if ch in seen:
            for alt in scored:
                if alt[1] not in seen:
                    cov, ch = alt
                    break
        seen.add(ch)
        uniq.append([cov, ch])
    # 强制两端：0 级必须是空格（等于不画），末级取最满的字
    uniq[0] = [0.0, " "]
    uniq[-1] = [scored[-1][0], scored[-1][1]]
    uniq.sort(key=lambda t: t[0])

    levels = [{"index": i, "char": ch, "coverage": cov} for i, (cov, ch) in enumerate(uniq)]
    cols = args.cols
    rows = math.ceil(n / cols)

    # 图集：alpha = 模糊后的墨量；RGB 白色，WebGL 只取 .a
    atlas = Image.new("RGBA", (cols * tile_w, rows * tile_h), (255, 255, 255, 0))
    for i, lv in enumerate(levels):
        if lv["char"] == " ":
            continue
        tile = Image.new("L", (tile_w, tile_h), 0)
        d = ImageDraw.Draw(tile)
        try:
            box = d.textbbox((0, 0), lv["char"], font=pil_font)
            w, h = box[2] - box[0], box[3] - box[1]
            d.text(((tile_w - w) / 2 - box[0], (tile_h - h) / 2 - box[1]),
                   lv["char"], font=pil_font, fill=255)
        except Exception:
            continue
        tile = tile.filter(ImageFilter.BoxBlur(1))
        rgba = Image.new("RGBA", (tile_w, tile_h), (255, 255, 255, 0))
        rgba.putalpha(tile)
        atlas.paste(rgba, ((i % cols) * tile_w, (i // cols) * tile_h))

    os.makedirs(args.out, exist_ok=True)
    atlas_path = os.path.join(args.out, "ramp-atlas.png")
    atlas.save(atlas_path, optimize=True)
    spec = {
        "version": 2,
        "generator": "ascii-full/scripts/gen-ramp.py",
        "font": os.path.basename(font_path),
        "fontNumber": args.font_number,
        "method": "rendered-ink-coverage / box-blur / quantile bins",
        "levels": levels,
        "atlas": {
            "file": "ramp-atlas.png", "tileW": tile_w, "tileH": tile_h,
            "cols": cols, "rows": rows, "count": n, "channel": "alpha",
            "note": "预烘焙字形；每级一个 tile，alpha=墨量。播放端按索引采样，不看字体 advance。"
        },
    }
    json_path = os.path.join(args.out, "ramp.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False, indent=1)

    print("级数: %d  · 图集 %dx%d tile / %dx%d 网格" % (n, tile_w, tile_h, cols, rows))
    print("覆盖率: %.4f … %.4f" % (levels[0]["coverage"], levels[-1]["coverage"]))
    print("已写出: %s (%d B)" % (json_path, os.path.getsize(json_path)))
    print("        %s (%d B)" % (atlas_path, os.path.getsize(atlas_path)))
    print("把这两个文件放进产物目录，再用 --ramp-file ramp.json 重转一次即可。")


def main():
    ap = argparse.ArgumentParser(description="生成 ascii-full 自定义字形覆盖率表")
    ap.add_argument("--font", default=None, help="字体文件 .ttf/.ttc/.otf；不给就自动找中文字体")
    ap.add_argument("--font-number", type=int, default=0, help=".ttc 里的字体序号，默认 0")
    ap.add_argument("--size", type=int, default=20, help="渲染字号，默认 20")
    ap.add_argument("--tile", type=int, default=24, help="图集每格边长 px，默认 24")
    ap.add_argument("--cols", type=int, default=16, help="图集每行 tile 数，默认 16")
    ap.add_argument("--levels", type=int, default=200, help="级数，上限 256（1 字节索引），默认 200")
    ap.add_argument("--limit", type=int, default=0, help="只扫前 N 个 cmap 码位，0=全扫（用于快速试跑）")
    ap.add_argument("--out", default="./ramp", help="输出目录")
    build(ap.parse_args())


if __name__ == "__main__":
    main()
