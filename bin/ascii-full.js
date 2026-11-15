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
// --ramp-file 指向 scripts/gen-ramp.py 产出的 ramp.json：
// 字形表像音轨一样单独成路，chunks 格式不动，只是索引按新表重新量化一次。
const RAMP_FILE_RAW = opt('ramp-file', null);
const RAMP_FILE = RAMP_FILE_RAW ? path.resolve(String(RAMP_FILE_RAW)) : null;
// --gamut: auto(读 ffprobe) / srgb / p3 / expand(实验性，显式扩色域)
const GAMUT = String(opt('gamut', 'auto')).toLowerCase();
const FORCE = FLAG('force');

// ---- 音频：旁路单轨，格式从第一天就是 tracks[]，方便后期叠加多路 ----
// 画面进 chunks/，声音进 audio/，两条路彻底独立。默认不抽（老产物零变化）；
// --audio 显式开启；已有产物想补/叠加用 bin/attach-audio.js，不必重转画面。
const AUDIO = FLAG('audio') && !FLAG('no-audio');
const AUDIO_CODEC = String(opt('audio-codec', 'opus')).toLowerCase();
const AUDIO_BITRATE = String(opt('audio-bitrate', '48k'));
const AUDIO_ID = String(opt('audio-id', 'main')).replace(/[^A-Za-z0-9_-]/g, '_');
const AUDIO_SPEC = {
  opus: { ext: 'webm', enc: 'libopus',    ar: '48000', mime: 'audio/webm; codecs=opus' },
  mp3:  { ext: 'mp3',  enc: 'libmp3lame', ar: '44100', mime: 'audio/mpeg' },
  pcm:  { ext: 'wav',  enc: 'pcm_s16le',  ar: '22050', mime: 'audio/wav' },
};
if (AUDIO && !AUDIO_SPEC[AUDIO_CODEC]) {
  console.error('✗ 不支持的音频编码: ' + AUDIO_CODEC + '（opus / mp3 / pcm）');
  process.exit(1);
}
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
let RAMP = RAMP_MODE === '10' ? RAMP_10 : RAMP_70;
let RAMP_SPEC = null;
if (RAMP_FILE) {
  if (!fs.existsSync(RAMP_FILE)) {
    console.error('✗ 找不到 ramp 文件: ' + RAMP_FILE); process.exit(1);
  }
  let j;
  try { j = JSON.parse(fs.readFileSync(RAMP_FILE, 'utf8')); }
  catch (e) { console.error('✗ ramp 文件不是合法 JSON: ' + e.message); process.exit(1); }
  const levels = j.levels;
  if (!Array.isArray(levels) || levels.length < 2 || levels.length > 256) {
    console.error('✗ ramp.levels 必须是 2~256 项（1 字节索引上限）'); process.exit(1);
  }
  const chars = levels.map(l => String((l && l.char) ?? ' '));
  // 每个字必须是 1 个 UTF-16 单元：非 BMP 字（emoji）会让 ramp[idx] 整体错位。
  const bad = chars.findIndex(c => c.length !== 1);
  if (bad >= 0) {
    console.error(`✗ ramp.levels[${bad}].char 不是一个 UTF-16 单元（可能是 emoji / 非 BMP 字）`);
    process.exit(1);
  }
  if (chars[0] !== ' ') {
    console.error('✗ ramp.levels[0].char 必须是空格（索引 0 = 不画）'); process.exit(1);
  }
  const atlas = j.atlas || null;
  RAMP = chars.join('');
  RAMP_SPEC = {
    version: 2,
    count: RAMP.length,
    file: 'ramp.json',
    sourceFont: j.font || null,
    method: j.method || 'custom',
    atlas: atlas ? {
      file: path.basename(String(atlas.file || 'ramp-atlas.png')),
      tileW: atlas.tileW | 0, tileH: atlas.tileH | 0,
      cols: atlas.cols | 0, rows: atlas.rows | 0,
      count: atlas.count | 0, channel: atlas.channel || 'alpha',
    } : null,
    srcAtlasDir: atlas ? path.dirname(RAMP_FILE) : null,
  };
}
if (!['auto', 'srgb', 'p3', 'expand'].includes(GAMUT)) {
  console.error('✗ --gamut 只接受 auto / srgb / p3 / expand'); process.exit(1);
}

if (VERSION) { console.log('ascii字符画视频 ' + PKG.version); process.exit(0); }
if (HELP) {
  console.log(`ascii字符画视频 ${PKG.version} — 本地全帧率真彩字符画转码器

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
                               --cols 852 → 852×240（4× 密度，字符数 16×）
  --fps N          帧率，默认取源片原生帧率
                   超过源片时默认只复制帧（不增加信息）
  --interp         配合 --fps 做 minterpolate 运动补偿插帧（实验性）
                   在缩放后的网格上跑，代价小；离散色块可能有鬼影
  --from S         从第 S 秒开始
  --to S           到第 S 秒结束（不写 = 全片）
  --chunk N        每个 gzip 块装几帧，默认 60
  --ramp 10|70     内置灰度级数，默认 70
  --ramp-file F    实验性：加载自定义字形表 ramp.json（2~256 级，按覆盖率重新量化）
                    由 scripts/gen-ramp.py 生成；同时需要 ramp-atlas.png
                    表与图集必须与产物放在同一目录，换表必须重转（索引语义变了）
                    字形图集走 WebGL 一次 draw call，绕开逐格 fillText
                    出问题用 ?nogl=1 兜底，或删产物、不带本参数重转
  --gamut MODE     色域声明，默认 auto：
                    auto   读 ffprobe 的 color_primaries（BT.2020/P3 → p3，其余 → srgb）
                    srgb   强制按 sRGB 呈现
                    p3     声明数据为 Display P3（屏不支持时线性矩阵降级到 sRGB）
                    expand 实验性：数值仍是 sRGB，但请求在 P3 屏按 P3 呈现（更艳）
  --half           用 ▀ 上下各带一色，垂直分辨率翻倍（体积约 1.75×）
  --force          产物已存在时清空重跑（清 chunks/ 与 meta.json，及 meta 里登记的音轨）

音频（旁路，默认关闭 —— 画面格式与老产物完全兼容）:
  --audio          从源片抽一条主音轨到 audio/main.webm，播放器以它为主时钟
  --audio-codec C  opus(默认) / mp3 / pcm
  --audio-bitrate R  默认 48k（pcm 忽略）
  --audio-id NAME  默认 main
  --no-audio       显式关闭（即使别处写了 --audio）
  补音轨 / 叠 BGM / 多语种，不重转画面:
  node bin/attach-audio.js --out DIR --src VIDEO
  node bin/attach-audio.js --out DIR --file bgm.m4a --id bgm --gain .6
  音轨是 meta.audio.tracks[] 数组，各自带 gain / offset / role。

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
  浏览器打开 http://127.0.0.1:8080/   （根路径直接进播放器）`);
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
// 用户常把 ramp.json / 图集直接解压进产物目录，再拿它当 --ramp-file 重转。
// --force 会清掉 OUT 里的旧旁路文件，等于把源文件也删了（且同路径 copyFileSync 会失败）。
// 这种情况先读进内存，清理后从内存写回。
let rampSelfCopy = null;
if (FORCE && RAMP_FILE && path.dirname(RAMP_FILE) === OUT && fs.existsSync(RAMP_FILE)) {
  const atlasName = RAMP_SPEC && RAMP_SPEC.atlas && RAMP_SPEC.atlas.file
    ? path.basename(String(RAMP_SPEC.atlas.file)) : 'ramp-atlas.png';
  const atlasPath = path.join(path.dirname(RAMP_FILE), atlasName);
  rampSelfCopy = {
    json: fs.readFileSync(RAMP_FILE),
    atlasName: atlasName,
    atlas: fs.existsSync(atlasPath) ? fs.readFileSync(atlasPath) : null,
  };
}
// 重跑画面时，attach-audio --file 后期挂的 BGM/解说要原样继承下来，
// 不能因为一次 --force 就让用户重新挂一遍。
let keptAudioTracks = [];
if (fs.existsSync(metaPath) && !FORCE) {
  console.error('✗ 已存在 meta.json。确认要重跑请加 --force，或换 --out 目录。');
  process.exit(1);
}
if (FORCE && fs.existsSync(OUT)) {
  // 只清自己生成的产物，别把用户 cp 进来的 player.html 一起删了。
  // 音轨也只删 meta 里登记过的那些 —— 用户后期 --file 自挂的 BGM 不该被重转抹掉。
  let oldTracks = [];
  try {
    const old = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (old.audio && Array.isArray(old.audio.tracks)) oldTracks = old.audio.tracks;
  } catch {}
  keptAudioTracks = oldTracks.filter(t => t && t.source === 'file');
  fs.rmSync(path.join(OUT, 'chunks'), { recursive: true, force: true });
  for (const t of oldTracks) {
    if (t && t.source === 'file') continue;       // 外部挂的音频保留
    const rel = String((t && t.file) || '');
    if (/^audio\/[A-Za-z0-9._-]+$/.test(rel)) fs.rmSync(path.join(OUT, rel), { force: true });
  }
  fs.rmSync(metaPath, { force: true });
  // 换表重转时旧 ramp 文件不能留：播放器会按新 meta.rampSpec 去取，名字虽同但内容得同步。
  for (const f of ['ramp.json', 'ramp-atlas.png']) fs.rmSync(path.join(OUT, f), { force: true });
}
fs.mkdirSync(path.join(OUT, 'chunks'), { recursive: true });

// ---------- 探测源片 ----------
const probe = spawnSync(FFPROBE, [
  '-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,duration,codec_name,color_primaries,color_transfer,color_space,color_range',
  '-show_entries', 'format=duration', '-of', 'json', SRC,
], { encoding: 'utf8' });
if (probe.status !== 0) { console.error('✗ ffprobe 失败: ' + probe.stderr); process.exit(1); }
const P = JSON.parse(probe.stdout);
const st = P.streams[0];
const srcW = st.width, srcH = st.height;
const dur = parseFloat(st.duration || P.format.duration || '0');
function parseFps(s) { const m = /^(\d+)\/(\d+)$/.exec(s || ''); return m ? (+m[1] / +m[2]) : parseFloat(s); }
const srcFps = parseFps(st.r_frame_rate) || parseFps(st.avg_frame_rate) || 24;

// 色域只做「声明 + 播放端协商」，不重编码那 3 个颜色字节 —— 和音轨一样单独成路。
// 大多数 SDR mp4 是 BT.709 / 未标注：auto 会如实写 srgb，不会凭空把颜色变艳。
const prim = String(st.color_primaries || '').toLowerCase();
const trc  = String(st.color_transfer || '').toLowerCase();
const spc  = String(st.color_space || '').toLowerCase();
const rng  = String(st.color_range || '').toLowerCase();
const wide = /bt2020|smpte432|dci|p3/.test(prim + ' ' + spc);
let declaredGamut = 'srgb', gamutSource = 'probe';
if (GAMUT === 'expand')      { declaredGamut = 'p3';   gamutSource = 'expand'; }
else if (GAMUT === 'p3')     { declaredGamut = 'p3';   gamutSource = 'flag'; }
else if (GAMUT === 'srgb')   { declaredGamut = 'srgb'; gamutSource = 'flag'; }
else                         { declaredGamut = wide ? 'p3' : 'srgb'; }
const COLOR_INFO = {
  gamut: declaredGamut, source: gamutSource,
  primaries: prim || 'unspecified', transfer: trc || 'unspecified',
  matrix: spc || 'unspecified', range: rng || 'unspecified',
  note: '声明式：chunks 里仍是 8bit/通道数值，播放端按屏能力协商解释或降级',
};
const FPS = FPS_OVERRIDE ? parseFloat(FPS_OVERRIDE) : srcFps;
if (!(FPS > 0 && FPS <= 120)) { console.error('✗ 帧率异常: ' + FPS); process.exit(1); }

// 只问「有没有音轨」，不解码、不改画面管线。--map 0:a:0 在无音轨时会直接失败，
// 所以先探一次，缺音轨时产出静音产物并给提示，而不是整次转码报错。
let srcAudio = null;
if (AUDIO) {
  const ap = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels,duration', '-of', 'json', SRC],
  { encoding: 'utf8' });
  if (ap.status === 0) {
    try {
      const a = JSON.parse(ap.stdout).streams[0];
      srcAudio = {
        codec: a.codec_name || 'unknown',
        sampleRate: parseInt(a.sample_rate, 10) || 0,
        channels: parseInt(a.channels, 10) || 0,
        duration: parseFloat(a.duration || '0') || dur,
      };
    } catch {}
  }
}

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
    subtitle: `ascii字符画视频 ${PKG.version} · 本地全帧率真彩转码`,
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
  ['音轨', !AUDIO ? '未抽取（--audio 开启；老产物可用 attach-audio 补）'
            : !srcAudio ? '⚠ 源片无 a:0，产物将静音'
            : `${AUDIO_CODEC} ${AUDIO_BITRATE}  ${srcAudio.codec} ${srcAudio.sampleRate}Hz ${srcAudio.channels}ch  → audio/${AUDIO_ID}.${AUDIO_SPEC[AUDIO_CODEC].ext}`],
  ['色域', `${declaredGamut.toUpperCase()}  源标记 ${prim || '未标注'}  ·  ${gamutSource === 'expand' ? '实验性扩色域' : '声明式协商（不改颜色字节）'}`],
  ['字形', RAMP_SPEC ? `自定义 ${RAMP.length} 级（${path.basename(RAMP_FILE)} + 图集 WebGL）` : `内置 ${RAMP.length} 级（2D fillText）`],
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

  // 音轨在画面流彻底结束后才抽：spawnSync 会阻塞事件循环，并行跑会让
  // ff.stdout 的数据堆在内存里。抽音轨只要一两秒，放最后最稳。
  let audioTrack = null;
  if (AUDIO && srcAudio) {
    const spec = AUDIO_SPEC[AUDIO_CODEC];
    const fileName = AUDIO_ID + '.' + spec.ext;
    const dst = path.join(OUT, 'audio', fileName);
    fs.mkdirSync(path.join(OUT, 'audio'), { recursive: true });
    const aArgs = ['-v', 'error', '-ss', String(t0)];
    if (TO !== null && t1 > t0) aArgs.push('-t', String(t1 - t0));
    aArgs.push('-i', SRC, '-vn', '-map', '0:a:0',
      '-c:a', spec.enc, '-ac', '2', '-ar', spec.ar);
    if (AUDIO_CODEC !== 'pcm') aArgs.push('-b:a', AUDIO_BITRATE);
    aArgs.push('-y', dst);
    const ar = spawnSync(FFMPEG, aArgs, { encoding: 'utf8' });
    if (ar.status !== 0) {
      log.warn('抽音轨失败（画面不受影响）: ' + String(ar.stderr || '').trim().slice(0, 300));
    } else {
      const dp = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,sample_rate,channels,duration',
        '-show_entries', 'format=duration', '-of', 'json', dst], { encoding: 'utf8' });
      let pd = {};
      try { const j = JSON.parse(dp.stdout); pd = j.streams[0] || {}; } catch {}
      audioTrack = {
        id: AUDIO_ID, file: 'audio/' + fileName,
        codec: AUDIO_CODEC, mime: spec.mime,
        sampleRate: parseInt(pd.sample_rate, 10) || parseInt(spec.ar, 10),
        channels: parseInt(pd.channels, 10) || 2,
        duration: parseFloat(pd.duration || '0') || (t1 - t0),
        bitrate: AUDIO_CODEC === 'pcm' ? null : AUDIO_BITRATE,
        srcStart: t0, offset: 0, gain: 1,
        role: 'master', source: 'video',
      };
      log.stage('旁路音轨已写入 audio/' + fileName);
    }
  } else if (AUDIO && !srcAudio) {
    log.warn('源片没有音轨 a:0 —— 产物静音；可用 attach-audio.js --file 后挂');
  }

  const meta = {
    magic: 'ASCFULL1', version: 1,
    src: path.basename(SRC), srcW, srcH, srcCodec: st.codec_name, srcDuration: dur, srcFps,
    W, H, fps: FPS, ramp: RAMP, colors: HALF ? 2 : 1, half: HALF,
    interp: INTERP && FPS > srcFps, fpsUpsampled: FPS > srcFps,
    bytesPerCell, frameBytes: outFrameBytes, chunkFrames: CHUNK,
    frames, chunks: chunkNo, from: t0, to: t1,
    generatedAt: new Date().toISOString(),
  };
  // 两路旁路：字形表与色域声明。都不进 chunks，老播放器不认识就走内置 70 级 / sRGB。
  if (RAMP_SPEC) {
    const clean = Object.assign({}, RAMP_SPEC);
    delete clean.srcAtlasDir;                 // 本机绝对路径不写进产物
    meta.rampSpec = clean;
  }
  meta.color = COLOR_INFO;
  // 音频是 tracks[] 而不是单个文件：第一条为 master 主时钟，其余为 overlay，
  // 每条自带 gain / offset / role。后期叠 BGM、解说、多语种只往数组追加即可。
  // --force 重转画面时，source:'file' 的外部音轨原样继承，不用重新挂。
  const allTracks = audioTrack ? [audioTrack] : [];
  for (const t of keptAudioTracks) allTracks.push(t);
  if (AUDIO || allTracks.length) {
    allTracks.forEach((t, i) => { t.role = i === 0 ? 'master' : 'overlay'; });
    meta.audio = { version: 1, master: 0, tracks: allTracks };
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  // 字形表 + 图集是产物目录里的两个静态小文件，播放端直接取，不作运行时依赖。
  let rampCopied = false;
  if (RAMP_SPEC) {
    if (rampSelfCopy) {
      fs.writeFileSync(path.join(OUT, 'ramp.json'), rampSelfCopy.json);
      if (rampSelfCopy.atlas) fs.writeFileSync(path.join(OUT, rampSelfCopy.atlasName), rampSelfCopy.atlas);
      else log.warn('找不到字形图集 ' + rampSelfCopy.atlasName + ' —— 播放器会回退 2D 字符路径');
    } else {
      fs.copyFileSync(RAMP_FILE, path.join(OUT, 'ramp.json'));
      const a = RAMP_SPEC.atlas;
      if (a && a.file) {
        const src = path.join(RAMP_SPEC.srcAtlasDir || path.dirname(RAMP_FILE), a.file);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, a.file));
        else log.warn('找不到字形图集 ' + src + ' —— 播放器会回退 2D 字符路径');
      }
    }
    rampCopied = true;
  }

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
    `音轨      : ${meta.audio
                  ? `${meta.audio.tracks.length} 条（主时钟 ${meta.audio.tracks[0] ? meta.audio.tracks[0].id : '—'}）` +
                    (audioTrack ? `  新抽 ${audioTrack.codec} ${audioTrack.sampleRate}Hz  ${(fs.statSync(path.join(OUT, audioTrack.file)).size / 1024).toFixed(0)} KB` : '  ⚠ 本次未抽到主音轨') +
                    (keptAudioTracks.length ? `  · 继承 ${keptAudioTracks.length} 条外部叠加轨` : '')
                  : '未抽取（--audio 开启；可用 attach-audio 补而不重转）'}`,
    `字形表    : ${RAMP_SPEC ? `自定义 ${RAMP.length} 级 · ramp.json + 图集 ${rampCopied ? '已复制 ✓' : '⚠ 缺失'} · WebGL 一次 draw call` : `内置 ${RAMP.length} 级 · 2D 字符路径`}`,
    `色域      : ${declaredGamut.toUpperCase()}（${gamutSource === 'expand' ? '实验性扩色域' : gamutSource === 'flag' ? '手动声明' : '按源片标记自动'}）· ${prim || '源未标注'} · 声明式，颜色字节未改`,
    `播放器    : ${playerCopied ? '已自动放入输出目录 ✓' : '⚠ 仓库 web/player.html 缺失，需手动复制一份'}`,
  ]);
  console.log('');
  console.log('  下一步（纯本地，无需联网）：');
  console.log(`    ascii-full-serve "${OUT}" --open`);
  console.log(`    # 或: cd "${OUT}" && python3 -m http.server 8080`);
  console.log('    浏览器开 http://127.0.0.1:8080/  （根路径直接进播放器）');
  log.close();
});
