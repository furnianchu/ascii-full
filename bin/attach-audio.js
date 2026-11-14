#!/usr/bin/env node
/*
 * ascii-full-attach-audio —— 给已有产物补/加/删音轨，完全不碰 chunks
 *
 * 画面与音频从一开始就是两条独立的路：chunks/*.gz 只管画，audio/ 只管声。
 * 所以后期想叠 BGM、环境音、解说、多语种，都是往 meta.audio.tracks[] 里
 * 追加一条，转码器、播放器、docs/FORMAT.md 一个字节都不用改。
 *
 *   node bin/attach-audio.js --src VIDEO --out DIR                # 从视频抽主音轨
 *   node bin/attach-audio.js --file bgm.m4a --out DIR --id bgm \
 *        --gain 0.6 --offset 1.5                                  # 直接挂一条 BGM
 *   node bin/attach-audio.js --out DIR --list                     # 列出现有轨
 *   node bin/attach-audio.js --out DIR --remove bgm               # 删一条
 *   node bin/attach-audio.js --out DIR --master bgm               # 换主时钟轨
 *
 * 依赖：ffmpeg / ffprobe（PATH） + Node >= 18。零 npm 依赖。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
function opt(n, d) {
  const i = argv.indexOf('--' + n);
  if (i < 0) return d;
  if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) return true;
  return argv[i + 1];
}
const FLAG = n => argv.includes('--' + n);

const OUT = path.resolve(String(opt('out', path.join(process.cwd(), 'ascii-out'))));
const SRC_RAW = opt('src', null);
const FILE_RAW = opt('file', null);
const SRC = SRC_RAW ? path.resolve(String(SRC_RAW)) : null;
const AFILE = FILE_RAW ? path.resolve(String(FILE_RAW)) : null;
const CODEC = String(opt('codec', 'opus')).toLowerCase();
const BITRATE = String(opt('bitrate', '48k'));
const ID_RAW = opt('id', null);
const GAIN = Math.max(0, Math.min(4, parseFloat(opt('gain', '1')) || 1));
const OFFSET = parseFloat(opt('offset', '0')) || 0;
const ROLE = String(opt('role', 'overlay')).toLowerCase();
const REPLACE = FLAG('replace');
const LIST = FLAG('list');
const REMOVE = opt('remove', null);
const MASTER = opt('master', null);
const HELP = FLAG('help');
const FFMPEG = String(opt('ffmpeg', 'ffmpeg'));
const FFPROBE = String(opt('ffprobe', 'ffprobe'));

const CODECS = {
  opus: { ext: 'webm', enc: 'libopus',    ar: '48000', mime: 'audio/webm; codecs=opus' },
  mp3:  { ext: 'mp3',  enc: 'libmp3lame', ar: '44100', mime: 'audio/mpeg' },
  pcm:  { ext: 'wav',  enc: 'pcm_s16le',  ar: '22050', mime: 'audio/wav' },
};
const MIME_BY_EXT = {
  '.webm': 'audio/webm', '.opus': 'audio/ogg', '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.mp4': 'audio/mp4',
};

if (HELP) {
  console.log(`ascii-full-attach-audio — 旁路音轨管理（不重转画面）

用法:
  node bin/attach-audio.js --out DIR --src VIDEO [选项]
  node bin/attach-audio.js --out DIR --file AUDIO [选项]
  node bin/attach-audio.js --out DIR --list | --remove ID | --master ID

新增一条音轨:
  --src FILE       从视频里抽音轨（区间自动取 meta.from / meta.to）
  --file FILE      直接挂一份现成音频文件，不重编码（BGM / 解说用这个）
  --id NAME        轨 id，默认 main；已被占用时自动顺延 track2/track3…
  --codec opus|mp3|pcm   从 --src 抽取时的编码，默认 opus
  --bitrate RATE   默认 48k（pcm 忽略）
  --gain 0~4       该轨音量，默认 1；播放器里也能实时拖
  --offset S       该轨相对主时钟的偏移（秒，可负），默认 0
  --role master    把新轨设为主时钟（默认第一条自动是 master）
  --replace        同 id 已存在时覆盖，而不是顺延

管理:
  --list           列出所有轨
  --remove ID      删除一条轨及其音频文件
  --master ID      把某条轨设为主时钟（帧索引跟它走）
  --out DIR        产物目录，默认 ./ascii-out
  --ffmpeg PATH / --ffprobe PATH   打包版指定二进制

示例 —— 三路叠加:
  node bin/attach-audio.js --src pv.mp4 --out out --id main
  node bin/attach-audio.js --file bgm.m4a --out out --id bgm --gain .5
  node bin/attach-audio.js --file voice.wav --out out --id voice --offset .12
  node bin/attach-audio.js --out out --list

注意: 只写 audio/ 与 meta.json，chunks/ 与所有画面帧数据一动不动。`);
  process.exit(0);
}

const metaPath = path.join(OUT, 'meta.json');
if (!fs.existsSync(metaPath)) {
  console.error('✗ 找不到 ' + metaPath + '\n  先跑 ascii-full 转码，或确认 --out 指对了目录。');
  process.exit(1);
}
let M;
try { M = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
catch (e) { console.error('✗ meta.json 解析失败: ' + e.message); process.exit(1); }
if (M.magic !== 'ASCFULL1') {
  console.error('✗ 这不是 ascii-full 产物（magic=' + M.magic + '）');
  process.exit(1);
}

function audioObj() {
  if (!M.audio || typeof M.audio !== 'object') M.audio = { version: 1, master: 0, tracks: [] };
  if (!Array.isArray(M.audio.tracks)) M.audio.tracks = [];
  if (typeof M.audio.master !== 'number') M.audio.master = 0;
  return M.audio;
}
// 老产物的播放器是 v1.3 及更早的，不认识 meta.audio —— 只补音轨不换播放器
// 会出现「文件都在、就是没声音」。沿用转码器的做法，写 meta 时顺手同步。
// 已是新版（含 meta.audio）就别动，允许产物目录里放自定义播放器。
function syncPlayer() {
  const src = path.join(__dirname, '..', 'web', 'player.html');
  const dst = path.join(OUT, 'player.html');
  if (!fs.existsSync(src)) return;
  try {
    if (fs.existsSync(dst) && fs.readFileSync(dst, 'utf8').includes('meta.audio')) return;
    fs.copyFileSync(src, dst);
  } catch { /* 只读目录等场景不影响补音轨本身 */ }
}
function save() {
  if (M.audio && M.audio.tracks && M.audio.tracks.length === 0) M.audio.master = 0;
  M.audioUpdatedAt = new Date().toISOString();
  fs.writeFileSync(metaPath, JSON.stringify(M, null, 2));
  syncPlayer();
}
function size(p) {
  try { return (fs.statSync(p).size / 1048576).toFixed(2) + ' MB'; } catch { return '—'; }
}

// ---------- 管理命令 ----------
if (LIST) {
  const A = audioObj();
  if (!A.tracks.length) { console.log('（暂无音轨 —— 产物静音）'); process.exit(0); }
  console.log('  轨   id        role      gain   offset    文件');
  A.tracks.forEach((t, i) => {
    console.log(`  ${String(i).padStart(2)}   ${String(t.id).padEnd(9)} ${String(t.role || 'overlay').padEnd(9)} ` +
      `${String(t.gain ?? 1).padEnd(6)} ${String(t.offset ?? 0).padEnd(9)} ${t.file}  ${size(path.join(OUT, t.file))}` +
      (i === A.master ? '   ← master 主时钟' : ''));
  });
  process.exit(0);
}
if (REMOVE) {
  const A = audioObj();
  const i = A.tracks.findIndex(t => t.id === String(REMOVE));
  if (i < 0) { console.error('✗ 没有这条轨: ' + REMOVE); process.exit(1); }
  const t = A.tracks[i];
  if (/^audio\/[A-Za-z0-9._-]+$/.test(String(t.file || ''))) {
    fs.rmSync(path.join(OUT, t.file), { force: true });
  }
  A.tracks.splice(i, 1);
  if (A.master >= A.tracks.length || A.master === i) A.master = 0;
  save();
  console.log(`✓ 已删除 ${t.id}（chunks 未改动，剩余 ${A.tracks.length} 条轨）`);
  process.exit(0);
}
if (MASTER) {
  const A = audioObj();
  const i = A.tracks.findIndex(t => t.id === String(MASTER));
  if (i < 0) { console.error('✗ 没有这条轨: ' + MASTER); process.exit(1); }
  A.master = i;
  A.tracks.forEach((t, k) => { t.role = k === i ? 'master' : 'overlay'; });
  save();
  console.log(`✓ 主时钟改为 ${A.tracks[i].id}（帧索引现在跟它走）`);
  process.exit(0);
}

// ---------- 新增一条 ----------
if (!SRC && !AFILE) {
  console.error('✗ 需要 --src VIDEO 或 --file AUDIO。管理命令用 --list / --remove / --master。');
  process.exit(1);
}
if (SRC && !fs.existsSync(SRC)) { console.error('✗ 找不到源片: ' + SRC); process.exit(1); }
if (AFILE && !fs.existsSync(AFILE)) { console.error('✗ 找不到音频: ' + AFILE); process.exit(1); }
if (!CODECS[CODEC]) { console.error('✗ 不支持的编码: ' + CODEC + '（opus / mp3 / pcm）'); process.exit(1); }
for (const [label, bin] of [['ffmpeg', FFMPEG], ['ffprobe', FFPROBE]]) {
  const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });
  if (r.error || r.status !== 0) { console.error(`✗ 无法执行 ${label}。确认 PATH 里有 ffmpeg / ffprobe。`); process.exit(1); }
}

const A = audioObj();
let id = ID_RAW ? String(ID_RAW).replace(/[^A-Za-z0-9_-]/g, '_') : 'main';
if (!/^[A-Za-z0-9_-]+$/.test(id)) { console.error('✗ --id 只允许字母数字下划线连字符'); process.exit(1); }
const existing = A.tracks.findIndex(t => t.id === id);
if (existing >= 0) {
  if (REPLACE) {
    const old = A.tracks[existing];
    if (/^audio\/[A-Za-z0-9._-]+$/.test(String(old.file || ''))) fs.rmSync(path.join(OUT, old.file), { force: true });
    A.tracks.splice(existing, 1);
    if (A.master > existing) A.master--;
  } else {
    let n = 2;
    while (A.tracks.some(t => t.id === 'track' + n)) n++;
    id = 'track' + n;
    console.log(`  · id 已占用，顺延为 ${id}`);
  }
}

fs.mkdirSync(path.join(OUT, 'audio'), { recursive: true });
let fileName, trackInfo;

function probeAudio(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels,duration',
    '-show_entries', 'format=duration', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    const s = JSON.parse(r.stdout).streams[0];
    const fmt = JSON.parse(r.stdout).format || {};
    return {
      codec: s.codec_name || 'unknown',
      sampleRate: parseInt(s.sample_rate, 10) || 0,
      channels: parseInt(s.channels, 10) || 0,
      duration: parseFloat(s.duration || fmt.duration || '0') || 0,
    };
  } catch { return null; }
}

if (AFILE) {
  // 直接挂现成音频：不重编码，质量原样保留，最适合叠 BGM / 解说
  const ext = path.extname(AFILE).toLowerCase();
  fileName = id + ext;
  const dst = path.join(OUT, 'audio', fileName);
  fs.copyFileSync(AFILE, dst);
  const p = probeAudio(dst) || {};
  trackInfo = {
    id, file: 'audio/' + fileName,
    codec: p.codec || ext.slice(1) || 'unknown',
    mime: MIME_BY_EXT[ext] || 'application/octet-stream',
    sampleRate: p.sampleRate || 0, channels: p.channels || 0,
    duration: p.duration || 0, bitrate: null,
    srcStart: M.from || 0, offset: OFFSET, gain: GAIN,
    role: ROLE === 'master' ? 'master' : 'overlay',
    source: 'file',
  };
} else {
  // 从视频抽：区间与产物画面严格一致（ascii-full 用 -ss from / -t to-from）
  const from = Number(M.from || 0);
  const to = Number(M.to || M.srcDuration || 0);
  const spec = CODECS[CODEC];
  fileName = id + '.' + spec.ext;
  const dst = path.join(OUT, 'audio', fileName);
  const hasAudio = probeAudio(SRC);
  if (!hasAudio) {
    console.error('✗ 源片没有音轨 a:0。想叠外部音频请用 --file。');
    process.exit(1);
  }
  const args = ['-v', 'error', '-ss', String(from)];
  if (to > from) args.push('-t', String(to - from));
  args.push('-i', SRC, '-vn', '-map', '0:a:0', '-c:a', spec.enc, '-ac', '2', '-ar', spec.ar);
  if (CODEC !== 'pcm') args.push('-b:a', BITRATE);
  args.push('-y', dst);
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('✗ 抽音轨失败:\n' + (r.stderr || '').trim());
    console.error('  换 --codec mp3 或 --codec pcm 再试；画面产物不受影响。');
    process.exit(1);
  }
  const p = probeAudio(dst) || hasAudio;
  trackInfo = {
    id, file: 'audio/' + fileName,
    codec: CODEC, mime: spec.mime,
    sampleRate: p.sampleRate || parseInt(spec.ar, 10),
    channels: p.channels || 2,
    duration: p.duration || (to - from),
    bitrate: CODEC === 'pcm' ? null : BITRATE,
    srcStart: from, offset: OFFSET, gain: GAIN,
    role: ROLE === 'master' ? 'master' : 'overlay',
    source: 'video',
  };
}

const insertAt = A.tracks.length;
A.tracks.push(trackInfo);
if (ROLE === 'master' || insertAt === 0) {
  A.master = insertAt;
  A.tracks.forEach((t, k) => { t.role = k === A.master ? 'master' : 'overlay'; });
} else {
  trackInfo.role = 'overlay';
}
save();

const kb = fs.statSync(path.join(OUT, 'audio', fileName)).size / 1024;
console.log(`\n✓ 已挂载音轨 ${id}`);
console.log(`  文件    audio/${fileName}  (${kb.toFixed(0)} KB)`);
console.log(`  编码    ${trackInfo.codec}  ${trackInfo.sampleRate}Hz  ${trackInfo.channels}ch  ${trackInfo.duration.toFixed(1)}s`);
console.log(`  音量    ${GAIN}   偏移 ${OFFSET}s   角色 ${trackInfo.role}`);
console.log(`  当前    ${A.tracks.length} 条轨，主时钟 = ${A.tracks[A.master] ? A.tracks[A.master].id : '—'}`);
console.log(`  chunks/ 与 ${M.frames} 帧画面数据未改动（未重转）`);
console.log(`\n  播放: ascii-full-serve "${OUT}"  →  http://127.0.0.1:8080/`);
