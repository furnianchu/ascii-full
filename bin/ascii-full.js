#!/usr/bin/env node
/*
 * ascii-full —— offline full-fidelity truecolor ASCII video transcoder
 *
 * 把任意视频转成本地可播的字符画帧数据，全程离线、零 npm 运行时依赖：
 *   · 帧率  = 源片原生帧率（默认不降帧）
 *   · 网格  = 按源片宽高比自动计算列数，显示比例不失真
 *   · 颜色  = 每个字符独立 24-bit RGB（--half 时上下各一色，垂直分辨率翻倍）
 *   · 密度  = 默认 70 级灰度 ramp
 *   · 压缩  = 仅按 chunk 做 gzip 以便流式读取；不做帧间差分、不量化、不丢帧
 *
 * 产物是一组纯数据文件（meta.json + chunks/*.gz + player.html），
 * 不依赖任何服务端、不需要联网，也不绑定本项目之外的路径。
 *
 * 依赖：ffmpeg / ffprobe（PATH 里能执行） + Node >= 18。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync, spawn } = require('child_process');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) return true;
  return argv[i + 1];
}
const FLAG = n => argv.includes('--' + n);

// --src 必填；输出默认落在当前目录，避免猜测用户的家目录结构。
const SRC_RAW = opt('src', null);
const SRC = SRC_RAW ? path.resolve(String(SRC_RAW)) : null;
const OUT = path.resolve(String(opt('out', path.join(process.cwd(), 'ascii-out'))));
const GRID_H = Math.max(8, parseInt(opt('grid', '60'), 10));      // 行数（half 模式实际采样 2H 行）
const GRID_GIVEN = argv.indexOf('--grid') >= 0;
// --cols 单独给时按源片比例反算行数，实现「一个源采样点用 N×N 个字符表达」的超采样网格
const COLS_RAW = opt('cols', null);
const COLS = COLS_RAW === null ? null : Math.max(8, parseInt(String(COLS_RAW), 10));
const FPS_OVERRIDE = opt('fps', null);
const INTERP = FLAG('interp');               // --fps 超源片时用运动补偿插帧，而非复制帧
const CHUNK = Math.max(1, parseInt(opt('chunk', '60'), 10));      // 每个 gzip 块装几帧
const FROM = parseFloat(opt('from', '0')) || 0;
const TO = opt('to', null) === null ? null : parseFloat(opt('to', '0'));
const HALF = FLAG('half');                                       // ▀ 上下双色
const RAMP_MODE = String(opt('ramp', '70'));
const FORCE = FLAG('force');
const HELP = FLAG('help');
const VERSION = FLAG('version') || FLAG('V');

// 启动横幅（ASCII 大字）与结构化日志
const LOGO = String(opt('logo', 'ASCII FULL'));
const LOGO_CHAR = String(opt('logo-char', '#'));
const LOGO_FILE = opt('logo-file', null);
const NO_LOGO = FLAG('no-logo');
const LOG_FILE = opt('log-file', null);
const LOG_LEVEL = String(opt('log-level', 'DEBUG'));
const QUIET = FLAG('quiet');

// 桌面版把 ffmpeg/ffprobe 二进制一起打包，通过这两个参数传进来；
// 不传就走 PATH（终端版 / CI 的默认行为）。
const FFMPEG = String(opt('ffmpeg', 'ffmpeg'));
const FFPROBE = String(opt('ffprobe', 'ffprobe'));
const PKG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')); }
  catch { return { version: '0.0.0', name: 'ascii-full' }; }
})();

const RAMP_10 = " .:-=+*#%@";
const RAMP_70 = " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";
const RAMP = RAMP_MODE === '10' ? RAMP_10 : RAMP_70;

if (VERSION) { console.log(PKG.name + ' ' + PKG.version); process.exit(0); }
if (HELP) {
  console.log(`${PKG.name} ${PKG.version} — 本地全帧率真彩字符画转码器

用法:
  ascii-full --src VIDEO [--out DIR] [选项]
  node bin/ascii-full.js --src VIDEO [选项]        # 不装全局也能跑

必填:
  --src FILE       源视频（任意 ffmpeg 能解码的格式）

选项:
  --out DIR        输出目录，默认 ./ascii-out
  --grid N         字符行数，默认 60；列数按源片比例自动算（2.35:1 → 282×60）
  --cols N         直接指定字符列数；单独给时按比例自动反算行数
                   例 4K 16:9：--cols 426 → 426×120（2× 密度）
                               --cols 852 → 852×240（4× 密度 = 16 字符/采样点）
  --fps N          帧率，默认取源片原生帧率
                   超过源片时默认只复制帧（不增加信息）
  --interp         配合 --fps 做 minterpolate 运动补偿插帧（实验性）
                   在缩放后的网格上跑，代价小；离散色块可能有鬼影
  --from S         从第 S 秒开始
  --to S           到第 S 秒结束（不写 = 全片）
  --chunk N        每个 gzip 块装几帧，默认 60
  --ramp 10|70     灰度级数，默认 70
  --half           用 ▀ 上下各带一色，垂直分辨率翻倍（体积约 1.75×）
  --force          产物已存在时清空重跑（只清 chunks/ 与 meta.json）

启动外观 / 日志:
  --logo TEXT      启动大字的文字，默认 "ASCII FULL"（A-Z 0-9 与常用符号）
  --logo-char C    大字填充字符，默认 #
  --logo-file F    直接读一份现成 ASCII art（中文、∞ 之类用这个）
  --no-logo        不打印大字
  --log-file F     日志写到指定文件；默认 <输出目录>/ascii-full.log
  --log-level L    DEBUG/INFO/WARN/ERROR，默认 DEBUG
  --quiet          控制台只留进度与汇总（日志仍写盘）

给打包版用（一般不用手填）:
  --ffmpeg PATH    指定 ffmpeg 可执行文件，默认从 PATH 找
  --ffprobe PATH   指定 ffprobe 可执行文件，默认从 PATH 找
  --version, -V
  --help

档位建议: --grid 45 轻 / --grid 60 标准 / --grid 90 狠 / --grid 90 --half 最狠
超采样  : --cols 426 (2×) / --cols 852 (4×，字符数 16×、体积也 16×)
          播放器里先放大画布看，觉得细节不够再重转高密度档

跑完:
  ascii-full-serve <输出目录>        # 或 cd <目录> && python3 -m http.server 8080
  浏览器打开 http://localhost:8080/player.html`);
  process.exit(0);
}

// ---------- 前置检查 ----------
if (!SRC) { console.error('✗ 缺少 --src。例: ascii-full --src clip.mp4\n  完整参数见 --help'); process.exit(1); }
if (!fs.existsSync(SRC)) { console.error('✗ 找不到源片: ' + SRC); process.exit(1); }
// 直接执行二进制探测，别用 `which` —— 精简环境（Termux / 容器）可能没有 which，
// spawnSync 找不到它时 status=null，会把明明装好的 ffmpeg 误判成缺失。
for (const [label, bin] of [['ffmpeg', FFMPEG], ['ffprobe', FFPROBE]]) {
  const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });
  if (r.error || r.status !== 0) {
    console.error(`✗ 无法执行 ${label}${r.error ? ' (' + r.error.code + ')' : ''}`);
    console.error('  确认 PATH: ffmpeg -version | head -1');
    console.error('  安装: Termux `pkg install ffmpeg` / macOS `brew install ffmpeg` / Debian `apt install ffmpeg`');
    process.exit(1);
  }
}

const metaPath = path.join(OUT, 'meta.json');
if (fs.existsSync(metaPath) && !FORCE) {
  console.error('✗ 已存在 meta.json。确认要重跑请加 --force，或换 --out 目录。');
  process.exit(1);
}
if (FORCE && fs.existsSync(OUT)) {
  // 只清自己生成的产物，别把用户 cp 进来的 player.html 一起删了
  fs.rmSync(path.join(OUT, 'chunks'), { recursive: true, force: true });
  fs.rmSync(metaPath, { force: true });
}
fs.mkdirSync(path.join(OUT, 'chunks'), { recursive: true });

// ---------- 探测源片 ----------
const probe = spawnSync(FFPROBE, [
  '-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,duration,codec_name',
  '-show_entries', 'format=duration', '-of', 'json', SRC,
], { encoding: 'utf8' });
if (probe.status !== 0) { console.error('✗ ffprobe 失败: ' + probe.stderr); process.exit(1); }
const P = JSON.parse(probe.stdout);
const st = P.streams[0];
const srcW = st.width, srcH = st.height;
const dur = parseFloat(st.duration || P.format.duration || '0');
function parseFps(s) { const m = /^(\d+)\/(\d+)$/.exec(s || ''); return m ? (+m[1] / +m[2]) : parseFloat(s); }
const srcFps = parseFps(st.r_frame_rate) || parseFps(st.avg_frame_rate) || 24;
const FPS = FPS_OVERRIDE ? parseFloat(FPS_OVERRIDE) : srcFps;
if (!(FPS > 0 && FPS <= 120)) { console.error('✗ 帧率异常: ' + FPS); process.exit(1); }

// 等宽字体字符格约 1:2（宽:高），还原源片比例需要 W/(2H) = srcW/srcH
let W = Math.max(8, Math.round(2 * (srcW / srcH) * GRID_H));
let H = GRID_H;
if (COLS !== null) {
  W = COLS;
  // 只给 --cols 就按比例反算行数，避免把画面拉长/压扁
  if (!GRID_GIVEN) H = Math.max(8, Math.round(W / (2 * (srcW / srcH))));
}
const sampleH = HALF ? H * 2 : H;
const bytesPerCell = HALF ? 7 : 4;          // 1B 字符索引 + 3B×色数
const rawFrameBytes = W * sampleH * 3;       // ffmpeg rgb24
const cellCount = W * H;
const outFrameBytes = cellCount * bytesPerCell;
const t0 = FROM, t1 = (TO === null ? dur : Math.min(TO, dur));
const estFrames = Math.max(1, Math.ceil((t1 - t0) * FPS));

// ---------- 启动横幅（ASCII 大字）+ 结构化日志 ----------
const { print: printBanner } = require('./banner');
const { createLogger } = require('./logger');
if (!NO_LOGO) {
  printBanner({
    title: LOGO, char: LOGO_CHAR, file: LOGO_FILE,
    subtitle: `${PKG.name} ${PKG.version} · offline truecolor ascii transcoder`,
  });
}
const log = createLogger({ name: 'ascii-full', dir: OUT, file: LOG_FILE, quiet: QUIET, level: LOG_LEVEL });
log.startup([
  ['源片', `${path.basename(SRC)}  ${srcW}×${srcH}  ${st.codec_name}  ${dur.toFixed(1)}s @ ${srcFps.toFixed(3)}fps`],
  ['输出', OUT],
  ['网格', `${W}×${H}${HALF ? `（半块模式采样 ${W}×${sampleH}）` : ''}  ramp ${RAMP.length} 级  ${HALF ? '上下双色' : '每字符独立 truecolor'}`],
  ['帧率', `${FPS.toFixed(3)} fps   区间 ${t0.toFixed(1)}~${t1.toFixed(1)}s   预计 ${estFrames} 帧`],
  ['帧来源', INTERP && FPS > srcFps ? `minterpolate 运动补偿插帧（源片 ${srcFps.toFixed(3)}fps）`
            : FPS > srcFps ? `⚠ 高于源片，ffmpeg 复制帧填充（不增加信息）` : '源片原生帧率，无丢帧'],
  ['每帧', `${(outFrameBytes / 1024).toFixed(0)} KB   原始总计约 ${(estFrames * outFrameBytes / 1048576).toFixed(0)} MB`],
  ['ffmpeg', FFMPEG],
]);
log.stage('开始解码');

// ---------- ffmpeg 流式抽帧 ----------
// 插帧放在 scale 之后：在字符网格上做运动补偿，比在 4K 上便宜几个数量级。
// minterpolate 硬性要求输入 >= 32x32，小网格（如 --grid 20 -> 71x20）会直接
// 报 "Height or width < 32"。先等比例升到安全中间尺寸，插完帧再缩回目标网格。
let vf;
if (INTERP && FPS > srcFps) {
  let iw = W, ih = sampleH;
  if (iw < 32 || ih < 32) {
    const k = Math.max(64 / iw, 64 / ih, 1);
    iw = Math.round(iw * k); ih = Math.round(ih * k);
  }
  vf = `scale=${iw}:${ih}:flags=lanczos,` +
       `minterpolate=fps=${FPS}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,` +
       `scale=${W}:${sampleH}:flags=lanczos`;
} else {
  vf = `scale=${W}:${sampleH}:flags=lanczos,fps=${FPS}`;
}
const args = ['-v', 'error', '-ss', String(t0)];
if (TO !== null) args.push('-t', String(t1 - t0));
args.push('-i', SRC, '-vf', vf, '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');

const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let errBuf = '';
ff.stderr.on('data', d => { errBuf += d.toString(); });

let carry = Buffer.alloc(0);
let frames = 0;
let chunkBufs = [];
let chunkBytes = 0;
let rawTotal = 0, gzTotal = 0;
let chunkNo = 0;
let stopped = false;

function lum(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
function rampIdx(l) {
  let i = Math.floor((l / 256) * RAMP.length);
  return i < 0 ? 0 : i >= RAMP.length ? RAMP.length - 1 : i;
}

function encodeFrame(raw) {
  const out = Buffer.allocUnsafe(outFrameBytes);
  if (!HALF) {
    for (let i = 0; i < cellCount; i++) {
      const p = i * 3, r = raw[p], g = raw[p + 1], b = raw[p + 2], o = i * 4;
      out[o] = rampIdx(lum(r, g, b));
      out[o + 1] = r; out[o + 2] = g; out[o + 3] = b;
    }
  } else {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const top = (2 * y * W + x) * 3, bot = ((2 * y + 1) * W + x) * 3;
        const r1 = raw[top], g1 = raw[top + 1], b1 = raw[top + 2];
        const r2 = raw[bot], g2 = raw[bot + 1], b2 = raw[bot + 2];
        const o = (y * W + x) * 7;
        out[o] = rampIdx((lum(r1, g1, b1) + lum(r2, g2, b2)) / 2);
        out[o + 1] = r1; out[o + 2] = g1; out[o + 3] = b1;
        out[o + 4] = r2; out[o + 5] = g2; out[o + 6] = b2;
      }
    }
  }
  return out;
}

function flushChunk(final) {
  if (!chunkBufs.length) return;
  const body = Buffer.concat(chunkBufs, chunkBytes);
  const gz = zlib.gzipSync(body, { level: 6 });
  const name = `c_${String(chunkNo).padStart(5, '0')}.gz`;
  fs.writeFileSync(path.join(OUT, 'chunks', name), gz);
  rawTotal += body.length; gzTotal += gz.length;
  process.stdout.write(`\r  帧 ${String(frames).padStart(6)}   块 ${String(chunkNo + 1).padStart(4)}   gzip ${(gzTotal / 1048576).toFixed(1)} MB   `);
  log.progress(`帧 ${frames} / 块 ${chunkNo + 1} / gzip ${(gzTotal / 1048576).toFixed(1)} MB`);
  chunkNo++; chunkBufs = []; chunkBytes = 0;
  if (final) console.log('');
}

ff.stdout.on('data', d => {
  if (stopped) return;
  carry = carry.length ? Buffer.concat([carry, d]) : d;
  while (carry.length >= rawFrameBytes && !stopped) {
    const raw = carry.subarray(0, rawFrameBytes);
    carry = carry.subarray(rawFrameBytes);
    const enc = encodeFrame(raw);
    chunkBufs.push(enc); chunkBytes += enc.length; frames++;
    if (chunkBufs.length >= CHUNK) flushChunk(false);
  }
});

ff.on('error', e => { console.error('\n✗ ffmpeg 启动失败: ' + e.message); process.exit(1); });
ff.on('close', code => {
  if (stopped) return;
  stopped = true;
  if (code !== 0) { console.error('\n✗ ffmpeg 退出码 ' + code + '\n' + errBuf); process.exit(1); }
  flushChunk(true);
  if (!frames) { console.error('✗ 一帧都没解码出来，检查 --from/--to 或源片'); process.exit(1); }

  const meta = {
    magic: 'ASCFULL1', version: 1,
    src: path.basename(SRC), srcW, srcH, srcCodec: st.codec_name, srcDuration: dur, srcFps,
    W, H, fps: FPS, ramp: RAMP, colors: HALF ? 2 : 1, half: HALF,
    interp: INTERP && FPS > srcFps, fpsUpsampled: FPS > srcFps,
    bytesPerCell, frameBytes: outFrameBytes, chunkFrames: CHUNK,
    frames, chunks: chunkNo, from: t0, to: t1,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  // 播放器随产物一起走：服务起在 OUT，而 player.html 在仓库的 web/ 下，
  // 手动 cp 很容易漏（漏了就是 /player.html 404）。这里每次转码都同步一份。
  const selfPlayer = path.join(__dirname, '..', 'web', 'player.html');
  const outPlayer = path.join(OUT, 'player.html');
  let playerCopied = false;
  if (fs.existsSync(selfPlayer)) {
    fs.copyFileSync(selfPlayer, outPlayer);
    playerCopied = true;
  }

  log.stage('解码完成，产物已写入');
  log.summary([
    `帧数      : ${frames}   （${(frames / FPS).toFixed(1)} 秒 @ ${FPS.toFixed(3)}fps）`,
    `块数      : ${chunkNo}  每块 ${CHUNK} 帧`,
    `原始体积  : ${(rawTotal / 1048576).toFixed(1)} MB`,
    `gzip 后   : ${(gzTotal / 1048576).toFixed(1)} MB  （压缩比 ${(rawTotal / gzTotal).toFixed(1)}×）`,
    `每字符    : ${bytesPerCell} B（1 索引 + ${meta.colors * 3} RGB）`,
    `数据精度  : 全帧率 / ${RAMP.length} 级 / ${HALF ? '上下双色' : '每字符独立 24-bit 色'} / 无帧间差分`,
    `帧来源    : ${INTERP && FPS > srcFps ? '运动补偿插帧' : FPS > srcFps ? '复制帧（不增加信息）' : '源片原生'}（源片 ${srcFps.toFixed(3)}fps → ${FPS.toFixed(3)}fps）`,
    `播放器    : ${playerCopied ? '已自动放入输出目录 ✓' : '⚠ 仓库 web/player.html 缺失，需手动复制一份'}`,
  ]);
  console.log('');
  console.log('  下一步（纯本地，无需联网）：');
  console.log(`    ascii-full-serve "${OUT}"`);
  console.log(`    # 或: cd "${OUT}" && python3 -m http.server 8080`);
  console.log('    浏览器开 http://localhost:8080/player.html');
  log.close();
});
