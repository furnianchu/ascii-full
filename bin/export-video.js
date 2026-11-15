#!/usr/bin/env node
/*
 * ascii字符画视频 · 导出宣传片
 *
 * 把已经转好的产物（meta.json + chunks/*.gz）渲染成一支**普通 mp4**：
 * H.264 / yuv420p / AAC / faststart，点开就能播，直接传视频网站。
 *
 * 关键：这一步**不重新取色、不二次转码**。chunks 里 1B 索引 + 3B RGB 被
 * 原样画成像素再封进 mp4，相对 ascii1 数据零损失；信息损失只发生在
 * 第一步「源片 → 字符画数据」，不在这一步。
 *
 *   ascii-full --src 原片.mp4 --out ./ascii-out       ← ① 源片 → 字符画数据
 *   ascii-full-export --out ./ascii-out --to 宣传.mp4  ← ② 数据 → 字符画风格视频
 *
 * 零 npm 运行时依赖：ffmpeg / ffprobe + Node >= 18。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { spawnSync, spawn } = require('child_process');

// 每格按等宽字形的 1:2 比例铺真实像素；--scale 由 ffmpeg nearest 放大，不糊笔画
const CELL_W = 8, CELL_H = 16;
const CELL_PX = CELL_W * CELL_H;

const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) return true;
  return argv[i + 1];
}
const FLAG = n => argv.includes('--' + n);

const OUT = path.resolve(String(opt('out', opt('dir', null)) || ''));
const TO = opt('to', opt('file', null)) ? path.resolve(String(opt('to', opt('file', null)))) : null;
const FROM = Math.max(0, parseFloat(opt('from', '0')) || 0);
const DURATION_RAW = opt('duration', null);
const DURATION = DURATION_RAW === null ? null : Math.max(0.01, parseFloat(DURATION_RAW));
const MODE = String(opt('mode', 'glyph')).toLowerCase();
const GLYPH = String(opt('glyph', 'auto')).toLowerCase();
const SCALE = Math.min(4, Math.max(1, parseInt(opt('scale', '1'), 10) || 1));
const CRF = Math.min(51, Math.max(0, parseInt(opt('crf', '18'), 10)));
const PRESET = String(opt('preset', 'medium'));
const NO_AUDIO = FLAG('no-audio');
const FONT = opt('font', null);
const FFMPEG = String(opt('ffmpeg', 'ffmpeg'));
const FFPROBE = String(opt('ffprobe', 'ffprobe'));
const QUIET = FLAG('quiet');
const HELP = FLAG('help');
const VERSION = FLAG('version') || FLAG('V');

const PKG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')); }
  catch { return { version: '0.0.0' }; }
})();

if (VERSION) { console.log('ascii字符画视频 ' + PKG.version); process.exit(0); }
if (HELP) {
  console.log(`ascii字符画视频 ${PKG.version} — 导出宣传片（数据 → 普通 mp4）

用法:
  ascii-full-export --out 产物目录 --to 宣传片.mp4 [选项]

  ① 源片  --[ ascii-full ]-->  字符画数据 meta.json + chunks/*.gz
  ② 数据  --[ 本命令 ]----->  字符画风格视频（H.264/AAC，可直接上传）

必填:
  --out DIR       产物目录（别名 --dir），读 meta.json 与 chunks/
  --to FILE       输出 mp4（别名 --file）

截取（相对产物第 0 帧，不是原片时间轴）:
  --from S        从第 S 秒开始，默认 0
  --duration S    导出多少秒，默认全片
                  宣传片建议截 15~30 秒高光，只读覆盖到的几个 gzip 块

画面:
  --mode MODE     glyph(默认，黑底彩色字) / block(纯色块，快)
  --scale N       整数放大 1~4，默认 1；走 nearest，不插值、不糊笔画
                  例 --grid 60 的 282×60 → 2256×960，--scale 2 → 4512×1920
  --font FILE     生成字形图集用的字体；不填自动探测系统字体
  --glyph SRC     字形来源，默认 auto：
                    auto   产物自带图集 → 字体渲染 → 覆盖率网点（逐级兜底）
                    atlas  只用产物自带 ramp-atlas.png，缺了直接报错
                    font   只用字体渲染（--font 可指定）
                    dither 强制覆盖率网点（无字体环境 / 自检用），不是真字形
  --crf N         H.264 质量，默认 18（越小越好、越大越省）
  --preset NAME   x264 预设，默认 medium

声音:
  默认把 meta.audio.tracks[] 按各自 gain / offset 混成一条 AAC 192k
  --no-audio      导出纯画面（无声）

其他:
  --ffmpeg PATH / --ffprobe PATH   指定二进制
  --quiet         少打印
  --version, -V / --help

字形来源（自动，按优先级）:
  1. 产物自带 ramp-atlas.png（自定义字形表），零字体依赖
  2. 没有图集时用 ffmpeg drawtext 把 meta.ramp 渲染成图集
  3. 两者都不可用 → 明确警告并降级成覆盖率网点，绝不产出全黑视频

输出固定为 H.264 + yuv420p + BT.709 标记 + faststart，
视频网站 / 手机 / 电视都能直接播，不需要装任何东西。`);
  process.exit(0);
}

function die(msg) { console.error('✗ ' + msg); process.exit(1); }
function say(msg) { if (!QUIET) console.log(msg); }

if (!OUT || !fs.existsSync(OUT)) die('缺少有效的 --out 产物目录');
if (!TO) die('缺少 --to 输出 mp4 路径');
if (!['glyph', 'block'].includes(MODE)) die('--mode 只能是 glyph / block');
if (!['auto', 'atlas', 'font', 'dither'].includes(GLYPH)) die('--glyph 只能是 auto / atlas / font / dither');
if (FONT && !fs.existsSync(String(FONT))) die('找不到 --font 指定的字体文件：' + FONT);
for (const [label, bin] of [['ffmpeg', FFMPEG], ['ffprobe', FFPROBE]]) {
  const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });
  if (r.error || r.status !== 0) die(`无法执行 ${label}（PATH 里找不到？）`);
}

const META_PATH = path.join(OUT, 'meta.json');
if (!fs.existsSync(META_PATH)) die('产物目录里没有 meta.json：' + OUT);
let M;
try { M = JSON.parse(fs.readFileSync(META_PATH, 'utf8')); }
catch (e) { die('meta.json 不是合法 JSON: ' + e.message); }
if (M.magic !== 'ASCFULL1') die('不是 ascii-full 产物（magic 不匹配）');
const W = M.W, H = M.H, FPS = M.fps, CHUNK = M.chunkFrames,
      FB = M.frameBytes, BPC = M.bytesPerCell, HALF = !!M.half,
      LEVELS = (M.ramp || '').length;
if (!(W > 0 && H > 0 && FPS > 0 && FB > 0 && LEVELS >= 2)) die('meta.json 字段异常');

// 帧区间：--from/--duration 都相对产物第 0 帧
const startFrame = Math.min(M.frames, Math.floor(FROM * FPS));
const endFrame = DURATION === null
  ? M.frames
  : Math.min(M.frames, Math.ceil((FROM + DURATION) * FPS));
const outFrames = Math.max(1, endFrame - startFrame);
const outSeconds = outFrames / FPS;

const RAW_W = W * CELL_W, RAW_H = H * CELL_H;
const OUT_W = RAW_W * SCALE, OUT_H = RAW_H * SCALE;

// ---------- PNG 解码（零依赖，只支持本项目图集实际会用的 8bit 非隔行） ----------
// 用 zlib.inflateSync 自己解 IDAT，再逐行反 filter；取 alpha 作为字形墨量。
function decodePNG(buf) {
  if (buf.length < 8 || buf.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('不是 PNG');
  let off = 8, w = 0, h = 0, bd = 0, ct = 0, inter = 0;
  const idat = [];
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bd = data[8]; ct = data[9]; inter = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (bd !== 8 || inter !== 0) throw new Error('只支持 8bit 非隔行 PNG');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  if (!channels) throw new Error('不支持的 PNG colorType ' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.allocUnsafe(h * stride);
  let prev = Buffer.alloc(stride, 0);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (ft !== 0) throw new Error('未知 PNG filter ' + ft);
      line[x] = v & 255;
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return { w, h, channels, data: out, alphaIndex: ct === 6 ? 3 : ct === 4 ? 1 : -1 };
}

function escFilterPath(p) {
  return String(p).replace(/\\/g, '\\\\').replace(/:/g, '\\:')
                  .replace(/'/g, "\\'").replace(/%/g, '\\%').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

const FONT_CANDIDATES = [
  '/system/fonts/NotoSansCJK-Regular.ttc',
  '/system/fonts/DroidSansMono.ttf',
  '/system/fonts/Roboto-Regular.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/System/Library/Fonts/Menlo.ttc',
  '/Library/Fonts/Menlo.ttc',
  'C:/Windows/Fonts/consola.ttf',
];
function pickFont() {
  if (FONT) return { file: FONT, explicit: true };
  for (const f of FONT_CANDIDATES) if (fs.existsSync(f)) return { file: f, explicit: false };
  return null; // 让 ffmpeg drawtext 走 fontconfig 默认字体
}

// ---------- 覆盖率表：每个 level 一张 CELL_W×CELL_H 的 0..255 墨量 ----------
function fromPNGAtlas() {
  const spec = M.rampSpec && M.rampSpec.atlas;
  if (!spec || !spec.file) return null;
  const fp = path.join(OUT, path.basename(String(spec.file)));
  if (!fs.existsSync(fp)) return null;
  try {
    const img = decodePNG(fs.readFileSync(fp));
    const tw = spec.tileW | 0, th = spec.tileH | 0, cols = spec.cols | 0;
    if (!(tw > 0 && th > 0 && cols > 0)) throw new Error('图集尺寸字段异常');
    const alpha = img.alphaIndex >= 0;
    const cov = [];
    for (let lv = 0; lv < LEVELS; lv++) {
      const gx = lv % cols, gy = Math.floor(lv / cols);
      const tile = new Uint8Array(CELL_PX);
      for (let ty = 0; ty < CELL_H; ty++) {
        const sy = gy * th + Math.floor(ty * th / CELL_H);
        for (let tx = 0; tx < CELL_W; tx++) {
          const sx = gx * tw + Math.floor(tx * tw / CELL_W);
          if (sy >= img.h || sx >= img.w) continue;
          const p = (sy * img.w + sx) * img.channels;
          tile[ty * CELL_W + tx] = alpha
            ? img.data[p + img.alphaIndex]
            : (img.data[p] * 77 + img.data[p + 1] * 151 + img.data[p + 2] * 28) >> 8;
        }
      }
      cov.push(tile);
    }
    return { cov, source: '产物自带图集 ' + path.basename(fp) };
  } catch (e) {
    say('  · 图集解码失败，改用字体渲染：' + e.message);
    return null;
  }
}

function fromDrawtext() {
  // 每个字符写进单独的 textfile —— 绕开 drawtext 对 ' " \ : % 的转义地狱
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ascii-export-'));
  try {
    const font = pickFont();
    const fontPart = font ? `fontfile='${escFilterPath(font.file)}':` : '';
    const chain = [];
    for (let i = 0; i < LEVELS; i++) {
      const f = path.join(tmp, `g_${String(i).padStart(4, '0')}.txt`);
      fs.writeFileSync(f, M.ramp[i], 'utf8');
      chain.push(`drawtext=${fontPart}textfile='${escFilterPath(f)}':` +
        `fontcolor=white:fontsize=${CELL_H - 2}:` +
        `x=${i * CELL_W}+(${CELL_W}-text_w)/2:y=(${CELL_H}-text_h)/2`);
    }
    const r = spawnSync(FFMPEG, [
      '-v', 'error', '-f', 'lavfi', '-i',
      `color=c=black:s=${LEVELS * CELL_W}x${CELL_H}:r=1:d=1`,
      '-vf', chain.join(','), '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
    ], { maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout || r.stdout.length < LEVELS * CELL_PX) {
      say('  · drawtext 生成图集失败' + (font ? '（可试 --font 指定字体文件）' : '') +
          '：' + String(r.stderr || '').trim().slice(0, 160));
      return null;
    }
    const cov = [];
    for (let lv = 0; lv < LEVELS; lv++) {
      const tile = new Uint8Array(CELL_PX);
      for (let ty = 0; ty < CELL_H; ty++) {
        for (let tx = 0; tx < CELL_W; tx++) {
          tile[ty * CELL_W + tx] = r.stdout[ty * (LEVELS * CELL_W) + lv * CELL_W + tx];
        }
      }
      cov.push(tile);
    }
    return { cov, source: font ? `字体渲染（${path.basename(font.file)}）` : '字体渲染（ffmpeg 默认字体）' };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// 最后兜底：Bayer 4×4 有序抖动，用索引当密度。不是真字形，但绝不黑屏。
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
function fromDither() {
  const cov = [];
  for (let lv = 0; lv < LEVELS; lv++) {
    const tile = new Uint8Array(CELL_PX);
    const density = lv / (LEVELS - 1);
    for (let ty = 0; ty < CELL_H; ty++) {
      for (let tx = 0; tx < CELL_W; tx++) {
        const t = (BAYER[(ty % 4) * 4 + (tx % 4)] + 0.5) / 16;
        tile[ty * CELL_W + tx] = t < density ? 255 : 0;
      }
    }
    cov.push(tile);
  }
  return { cov, source: '覆盖率网点（降级，不是真字形）' };
}

function validateCov(cov) {
  let lit = 0;
  for (const tile of cov) {
    let s = 0;
    for (let i = 0; i < CELL_PX; i++) s += tile[i];
    if (s > 0) lit++;
  }
  return lit >= Math.max(2, Math.floor(LEVELS * 0.5));
}

let coverage = null, glyphSource = '色块';
if (MODE === 'glyph') {
  if (GLYPH === 'dither') {
    coverage = fromDither();
  } else if (GLYPH === 'atlas') {
    coverage = fromPNGAtlas();
    if (!coverage) die('--glyph atlas 但产物里没有可用的 ramp-atlas.png');
  } else if (GLYPH === 'font') {
    coverage = fromDrawtext();
    if (!coverage) die('--glyph font 但 ffmpeg drawtext 没能渲染出字形图集（可试 --font 指定字体）');
  } else {
    coverage = fromPNGAtlas() || fromDrawtext();
  }
  if (coverage && !validateCov(coverage.cov)) {
    say('  ⚠ 字形图集几乎没有墨量，判定不可用');
    coverage = null;
  }
  if (!coverage && GLYPH !== 'dither') {
    coverage = fromDither();
    say('  ⚠ 字形图集不可用 → 已降级为覆盖率网点；画面有颗粒但看不到真字');
  }
  if (!coverage) die('无法生成字形覆盖率表（不会产出全黑视频）');
  glyphSource = coverage.source;
}

// ---------- 帧读取：只读覆盖到的 gzip 块 ----------
let curChunk = -1, curData = null;
function frameAt(n) {
  const ci = Math.floor(n / CHUNK);
  if (ci !== curChunk) {
    const f = path.join(OUT, 'chunks', `c_${String(ci).padStart(5, '0')}.gz`);
    if (!fs.existsSync(f)) die('缺块：' + f + '（产物不完整）');
    curData = zlib.gunzipSync(fs.readFileSync(f));
    curChunk = ci;
  }
  const local = n % CHUNK;
  const off = local * FB;
  if (off + FB > curData.length) die('块 ' + ci + ' 长度不足，产物可能损坏');
  return curData.subarray(off, off + FB);
}

// ---------- 渲染一帧：黑底 + 每格按墨量染色 ----------
const frameBuf = Buffer.allocUnsafe(RAW_W * RAW_H * 3);
const rowBytes = RAW_W * 3;
function renderFrame(cellBytes) {
  frameBuf.fill(0);
  for (let cy = 0; cy < H; cy++) {
    for (let cx = 0; cx < W; cx++) {
      const o = (cy * W + cx) * BPC;
      const idx = cellBytes[o];
      const tile = coverage ? coverage.cov[idx] || coverage.cov[0] : null;
      const r1 = cellBytes[o + 1], g1 = cellBytes[o + 2], b1 = cellBytes[o + 3];
      const r2 = HALF ? cellBytes[o + 4] : r1;
      const g2 = HALF ? cellBytes[o + 5] : g1;
      const b2 = HALF ? cellBytes[o + 6] : b1;
      for (let ty = 0; ty < CELL_H; ty++) {
        const row = (cy * CELL_H + ty) * rowBytes + cx * CELL_W * 3;
        const r = ty < CELL_H / 2 ? r1 : r2;
        const g = ty < CELL_H / 2 ? g1 : g2;
        const b = ty < CELL_H / 2 ? b1 : b2;
        for (let tx = 0; tx < CELL_W; tx++) {
          const cov = MODE === 'block' ? 255 : tile[ty * CELL_W + tx];
          if (!cov) continue;                       // 背景保持纯黑，省掉大量写入
          const p = row + tx * 3;
          frameBuf[p]     = (r * cov) >> 8;
          frameBuf[p + 1] = (g * cov) >> 8;
          frameBuf[p + 2] = (b * cov) >> 8;
        }
      }
    }
  }
  return frameBuf;
}

// ---------- 音频：多轨按 gain / offset 混成一条 AAC ----------
const TRACKS = (!NO_AUDIO && M.audio && Array.isArray(M.audio.tracks))
  ? M.audio.tracks.filter(t => t && t.file && fs.existsSync(path.join(OUT, String(t.file))))
  : [];
const audioInputs = TRACKS.map(t => ['-i', path.join(OUT, String(t.file))]).flat();
const filters = [];
filters.push(SCALE > 1
  ? `[0:v]scale=${OUT_W}:${OUT_H}:flags=neighbor[v]`
  : '[0:v]null[v]');
if (TRACKS.length) {
  TRACKS.forEach((t, i) => {
    const gain = Number.isFinite(+t.gain) ? +t.gain : 1;
    const ms = Math.max(0, Math.round((Number.isFinite(+t.offset) ? +t.offset : 0) * 1000));
    const trim = `atrim=start=${FROM}:duration=${outSeconds},asetpts=PTS-STARTPTS,`;
    filters.push(`[${i + 1}:a]${trim}volume=${gain},adelay=${ms}|${ms}[a${i}]`);
  });
  filters.push(TRACKS.length === 1
    ? '[a0]anull[aout]'
    : TRACKS.map((_, i) => `[a${i}]`).join('') +
      `amix=inputs=${TRACKS.length}:duration=first:normalize=0[aout]`);
}

const ffArgs = [
  '-y', '-v', 'error',
  '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${RAW_W}x${RAW_H}`, '-r', String(FPS), '-i', 'pipe:0',
  ...audioInputs,
  '-filter_complex', filters.join(';'),
  '-map', '[v]',
];
if (TRACKS.length) ffArgs.push('-map', '[aout]');
ffArgs.push(
  '-c:v', 'libx264', '-preset', PRESET, '-crf', String(CRF),
  '-pix_fmt', 'yuv420p', '-r', String(FPS), '-vsync', 'cfr',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
);
if (TRACKS.length) ffArgs.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000');
else ffArgs.push('-an');
ffArgs.push('-movflags', '+faststart', '-t', outSeconds.toFixed(3), String(TO));

say(`ascii字符画视频 ${PKG.version} · 导出宣传片`);
say(`  产物    : ${OUT}  (${W}×${H} / ${FPS}fps / ${LEVELS} 级 / ${M.frames} 帧)`);
say(`  区间    : 帧 ${startFrame}~${endFrame}  → ${outFrames} 帧 / ${outSeconds.toFixed(1)}s`);
say(`  画面    : ${MODE === 'glyph' ? '字形' : '色块'} · ${OUT_W}×${OUT_H} (cell ${CELL_W}×${CELL_H} ×${SCALE})`);
say(`  字形来源: ${glyphSource}`);
say(`  声音    : ${TRACKS.length ? TRACKS.length + ' 轨混合 → AAC 192k' : '无（静音）'}`);
say(`  输出    : ${TO}`);
say('');

const ff = spawn(FFMPEG, ffArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
let errBuf = '';
ff.stderr.on('data', d => { errBuf += d.toString(); });

function write(buf) {
  return new Promise((resolve, reject) => {
    if (ff.stdin.write(buf)) return resolve();
    const onDrain = () => { cleanup(); resolve(); };
    const onErr = e => { cleanup(); reject(e); };
    const cleanup = () => {
      ff.stdin.removeListener('drain', onDrain);
      ff.stdin.removeListener('error', onErr);
    };
    ff.stdin.once('drain', onDrain);
    ff.stdin.once('error', onErr);
  });
}

(async () => {
  try {
    for (let n = startFrame; n < endFrame; n++) {
      await write(renderFrame(frameAt(n)));
      if (!QUIET && (n - startFrame + 1) % 30 === 0) {
        process.stdout.write(`\r  渲染 ${String(n - startFrame + 1).padStart(6)} / ${outFrames} 帧   `);
      }
    }
    ff.stdin.end();
  } catch (e) {
    ff.stdin.destroy();
    die('写帧管道失败: ' + e.message);
  }
})();

ff.on('error', e => die('ffmpeg 启动失败: ' + e.message));
ff.on('close', code => {
  if (!QUIET) console.log('');
  if (code !== 0) die('ffmpeg 退出码 ' + code + '\n' + errBuf.trim().slice(0, 1200));
  if (!fs.existsSync(TO)) die('ffmpeg 没写出文件');
  const size = fs.statSync(TO).size;
  const probe = spawnSync(FFPROBE, [
    '-v', 'error', '-show_entries',
    'stream=codec_name,codec_type,width,height,pix_fmt,r_frame_rate,nb_frames',
    '-show_entries', 'format=duration,size', '-of', 'json', String(TO),
  ], { encoding: 'utf8' });
  let info = {};
  try { info = JSON.parse(probe.stdout); } catch {}
  const v = (info.streams || []).find(s => s.codec_type === 'video') || {};
  const a = (info.streams || []).filter(s => s.codec_type === 'audio');
  console.log('');
  console.log('  导出完成 ✓');
  console.log(`    编码    : ${v.codec_name || 'h264'} / ${v.pix_fmt || 'yuv420p'} · ${a.length ? 'AAC ' + a.length + ' 轨' : '无音轨'}`);
  console.log(`    尺寸    : ${v.width || OUT_W}×${v.height || OUT_H} @ ${v.r_frame_rate || FPS + '/1'}`);
  console.log(`    帧数    : ${v.nb_frames || outFrames}   时长 ${(parseFloat((info.format || {}).duration) || outSeconds).toFixed(1)}s`);
  console.log(`    体积    : ${(size / 1048576).toFixed(1)} MB`);
  console.log(`    文件    : ${TO}`);
  console.log('');
  console.log('  H.264 + yuv420p + BT.709 + faststart → 直接传视频网站即可');
  console.log('  本地那份 meta.json + chunks/ 原样保留，仍可拖帧 / 换字形 / 叠音轨');
});
