#!/usr/bin/env node
/*
 * ascii-full-serve —— 给产物目录起一个零配置本地静态服务
 *
 *   ascii-full-serve [输出目录] [端口] [选项]
 *   ascii-full-serve ./ascii-out 8080 --open
 *   ascii-full-serve ./ascii-out --logo "YUEYUE" --no-logo   # 自定义/关掉启动大字
 *
 * 为什么需要它：浏览器不允许 file:// 页面 fetch 同目录的 .gz，必须走 HTTP。
 * 不想起服务也可以用 web/standalone.html —— 双击、拖入产物目录即可，零命令。
 *
 * 关键约定：.gz 以 application/octet-stream 原样返回，**不**加 Content-Encoding。
 * 文件本身已是 gzip 数据，播放器用 DecompressionStream('gzip') 自己解。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { print: printBanner } = require('./banner');
const { createLogger } = require('./logger');

const argv = process.argv.slice(2);
function opt(n, d) {
  const i = argv.indexOf('--' + n);
  if (i < 0) return d;
  if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) return true;
  return argv[i + 1];
}
const FLAG = n => argv.includes('--' + n);
const VALUE_OPTS = new Set(['--logo', '--logo-char', '--logo-file']);
const BOOL_OPTS = new Set(['--no-logo', '--open']);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    if (VALUE_OPTS.has(a)) i++;                                   // 跳过它的值
    else if (!BOOL_OPTS.has(a) && argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
    continue;
  }
  positional.push(a);
}
const ROOT = path.resolve(positional.find(a => !/^\d+$/.test(a)) || path.join(process.cwd(), 'ascii-out'));
const PORT = parseInt(positional.find(a => /^\d+$/.test(a)) || '8080', 10);
const NO_LOGO = FLAG('no-logo');
const LOGO = String(opt('logo', 'ASCII FULL'));
const LOGO_CHAR = String(opt('logo-char', '#'));
const LOGO_FILE = opt('logo-file', null);
const AUTO_OPEN = FLAG('open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.gz':   'application/octet-stream',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.txt':  'text/plain; charset=utf-8',
  '.log':  'text/plain; charset=utf-8',
};

if (!fs.existsSync(ROOT)) {
  console.error('✗ 目录不存在: ' + ROOT);
  console.error('  先跑: ascii-full --src VIDEO --out ' + ROOT);
  process.exit(1);
}

if (!NO_LOGO) {
  printBanner({
    title: LOGO, char: LOGO_CHAR, file: LOGO_FILE,
    subtitle: 'ascii-full-serve · 本地播放器（离线，零联网）',
  });
}
const log = createLogger({ name: 'ascii-full-serve', dir: ROOT });
log.startup([
  ['目录', ROOT],
  ['端口', String(PORT)],
  ['地址', `http://localhost:${PORT}/player.html`],
  ['产物', fs.existsSync(path.join(ROOT, 'meta.json')) ? 'meta.json ✓' : '⚠ 没找到 meta.json（转码可能还没跑完）'],
]);
log.stage('服务启动');

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400).end('Bad request'); return; }
  if (pathname === '/') pathname = '/player.html';

  const file = path.resolve(ROOT, '.' + pathname);
  // 目录穿越防护
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden'); return;
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('Not found'); return; }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
      // 故意不写 Content-Encoding: gzip
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}/player.html`;
  console.log(`  ▸ ${url}`);
  console.log('  Ctrl-C 退出\n');
  log.info('listening on ' + url);
  if (AUTO_OPEN) {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); }
    catch { log.warn('自动打开浏览器失败，请手动访问 ' + url); }
  }
});

process.on('SIGINT', () => { log.info('收到 Ctrl-C，退出'); server.close(() => process.exit(0)); });
