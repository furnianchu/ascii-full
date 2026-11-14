#!/usr/bin/env node
/*
 * ascii-full-term —— 在支持 truecolor 的终端里直接播字符画帧数据
 *
 *   ascii-full-term [输出目录] [--speed 1] [--start 0] [--stride 1] [--cache 5]
 *
 * 需要：终端支持 24-bit 色（$COLORTERM=truecolor），且列数 >= meta.W。
 * 手机竖屏通常不够，建议横屏 / 电脑终端；列数不够会折行，
 * 这时改用 web/player.html（canvas 自适应缩放）更舒服。
 *
 * 输出按「行内连续同色合并」压缩转义序列，比每字符发一次 38;2 省很多。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const argv = process.argv.slice(2);
function opt(n, d) { const i = argv.indexOf('--' + n); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d); }
const VALUE_OPTS = new Set(['--speed', '--start', '--stride', '--cache', '--logo', '--logo-char', '--logo-file', '--log-level']);
const BOOL_OPTS = new Set(['--no-logo', '--quiet']);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    if (VALUE_OPTS.has(a)) i++;
    else if (!BOOL_OPTS.has(a) && argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
    continue;
  }
  positional.push(a);
}
const DIR = path.resolve(positional[0] || path.join(process.cwd(), 'ascii-out'));
const SPEED = parseFloat(opt('speed', '1')) || 1;
const START = parseInt(opt('start', '0'), 10) || 0;
const STRIDE = Math.max(1, parseInt(opt('stride', '1'), 10));
const MAX_CACHE = Math.max(2, parseInt(opt('cache', '5'), 10) || 5);
const NO_LOGO = argv.includes('--no-logo');
const LOGO = String(opt('logo', 'ASCII FULL'));
const LOGO_CHAR = String(opt('logo-char', '#'));
const LOGO_FILE = opt('logo-file', null);

const metaPath = path.join(DIR, 'meta.json');
if (!fs.existsSync(metaPath)) { console.error('✗ 找不到 ' + metaPath + '，先跑: ascii-full --src VIDEO --out ' + DIR); process.exit(1); }
const M = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const cols = process.stdout.columns || 80;
const rows = process.stdout.rows || 24;

if (!NO_LOGO) {
  require('./banner').print({
    title: LOGO, char: LOGO_CHAR, file: LOGO_FILE,
    subtitle: 'ascii-full-term · truecolor terminal player',
  });
}
const log = require('./logger').createLogger({ name: 'ascii-full-term', dir: DIR });
log.startup([
  ['源片', M.src],
  ['网格', `${M.W}×${M.H}  ${M.fps.toFixed(2)}fps  ${M.frames} 帧`],
  ['终端', `${cols}×${rows}  缓存上限 ${MAX_CACHE} 块`],
  ['变速', `${SPEED}×  stride ${STRIDE}  起始帧 ${START}`],
]);
log.stage('开始播放');

console.log('源片 ' + M.src + '  网格 ' + M.W + '×' + M.H + '  ' + M.fps.toFixed(2) + 'fps  ' + M.frames + ' 帧');
if (cols < M.W || rows < M.H) {
  console.log('⚠ 当前终端 ' + cols + '×' + rows + '，网格是 ' + M.W + '×' + M.H + '，会折行。');
  console.log('  建议横屏/放大终端，或改用浏览器播放器（canvas 自适应）。');
}
console.log('空格/方向键不接，Ctrl-C 退出。\n');

const chunkCache = new Map();
function chunk(n) {
  if (chunkCache.has(n)) {
    const hit = chunkCache.get(n);
    chunkCache.delete(n); chunkCache.set(n, hit);   // 真 LRU：命中挪到末尾
    return hit;
  }
  const p = path.join(DIR, 'chunks', 'c_' + String(n).padStart(5, '0') + '.gz');
  const u8 = zlib.gunzipSync(fs.readFileSync(p));
  while (chunkCache.size >= MAX_CACHE) chunkCache.delete(chunkCache.keys().next().value);
  chunkCache.set(n, u8);
  return u8;
}

function frameData(f) {
  const n = Math.floor(f / M.chunkFrames), k = f % M.chunkFrames;
  return { u8: chunk(n), base: k * M.frameBytes };
}

function render(f) {
  const { u8, base } = frameData(f);
  let out = '\x1b[H';
  for (let y = 0; y < M.H; y++) {
    let line = '', prevFg = '', prevBg = '';
    for (let x = 0; x < M.W; x++) {
      const o = base + (y * M.W + x) * M.bytesPerCell;
      const fg = u8[o+1] + ';' + u8[o+2] + ';' + u8[o+3];
      const ch = M.ramp[u8[o]] || ' ';
      if (M.half) {
        const bg = u8[o+4] + ';' + u8[o+5] + ';' + u8[o+6];
        if (fg !== prevFg || bg !== prevBg) {
          line += '\x1b[38;2;' + fg + 'm\x1b[48;2;' + bg + 'm';
          prevFg = fg; prevBg = bg;
        }
        line += '▀';                       // 上半前景、下半背景
      } else {
        if (fg !== prevFg) { line += '\x1b[38;2;' + fg + 'm'; prevFg = fg; }
        line += ch;
      }
    }
    out += line + '\x1b[0m\n';
  }
  process.stdout.write(out);
}

// 隐藏光标 + 清屏
process.stdout.write('\x1b[?25l\x1b[2J');
function restore() {
  process.stdout.write('\x1b[0m\x1b[?25h\x1b[0J\n');
  process.exit(0);
}
process.on('SIGINT', restore);
process.on('SIGTERM', restore);

let f = Math.min(START, M.frames - 1);
const delay = 1000 / (M.fps * SPEED);
function loop() {
  render(f);
  f = (f + STRIDE) % M.frames;
  setTimeout(loop, delay);   // 不能 unref：这是主循环唯一的活跃 handle
}
loop();
