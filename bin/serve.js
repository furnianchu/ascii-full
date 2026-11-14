#!/usr/bin/env node
/*
 * ascii-full-serve —— 给产物目录起一个零配置本地服务，直接给一条可点的 URL
 *
 *   ascii-full-serve [输出目录] [端口] [选项]
 *   ascii-full-serve ./ascii-out 8080 --open          # 自动拉起浏览器
 *   ascii-full-serve ./ascii-out --lan                # 同一 WiFi 下别的设备也能开
 *   ascii-full-serve ./ascii-out --public https://abc.trycloudflare.com
 *
 * 根路径 "/" 直接进播放器，不需要补 /player.html（也不会再出目录列表）。
 * 想给公网域名：先跑 ascii-full-tunnel 拿到 https 链接，再用 --public 贴回来，
 * 这样启动横幅打印的就是域名而不是 127.0.0.1。
 *
 * 关键约定：.gz 以 application/octet-stream 原样返回，**不**加 Content-Encoding。
 * 文件本身已是 gzip 数据，播放器用 DecompressionStream('gzip') 自己解。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
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
const VALUE_OPTS = new Set(['--logo', '--logo-char', '--logo-file', '--host', '--public']);
const BOOL_OPTS = new Set(['--no-logo', '--open', '--lan']);
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
const LAN = FLAG('lan');
const HOST = LAN ? '0.0.0.0' : String(opt('host', '127.0.0.1'));
const PUBLIC = opt('public', null);

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
  '.url':  'text/plain; charset=utf-8',
  // 旁路音轨。audio/ 下的文件要给浏览器正确 MIME，且支持 Range（见下），
  // 否则 <audio> 拖进度在移动端会退化成整文件重下或直接播不动。
  '.webm': 'audio/webm',
  '.opus': 'audio/ogg',
  '.ogg':  'audio/ogg',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.m4a':  'audio/mp4',
  '.aac':  'audio/aac',
  '.flac': 'audio/flac',
};

function isTermux() {
  return !!(process.env.TERMUX_VERSION ||
    (process.env.PREFIX || '').includes('com.termux') ||
    fs.existsSync('/data/data/com.termux/files/usr/bin/termux-open-url'));
}

/** 枚举局域网 IPv4，优先常见家用网段，排除 docker / 回环 */
function lanIPs() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^169\.254\./.test(a.address)) continue;
      if (/^docker|^br-|^veth/.test(name)) continue;
      out.push({ name, address: a.address });
    }
  }
  return out.sort((x, y) => {
    const rank = s => /^192\.168\./.test(s) ? 0 : /^10\./.test(s) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(s) ? 2 : 3;
    return rank(x.address) - rank(y.address);
  });
}

/** Termux 用 termux-open-url（需装 Termux:API），桌面退回 open / xdg-open / start */
function openURL(url) {
  const cmd = isTermux() ? 'termux-open-url'
    : process.platform === 'win32' ? 'cmd'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => log.warn('自动打开失败，请手动点下面那条链接'));
    p.unref();
    return cmd;
  } catch { log.warn('自动打开失败，请手动点下面那条链接'); return null; }
}

if (!fs.existsSync(ROOT)) {
  console.error('✗ 目录不存在: ' + ROOT);
  console.error('  先跑: ascii-full --src VIDEO --out ' + ROOT);
  process.exit(1);
}

if (!NO_LOGO) {
  printBanner({
    title: LOGO, char: LOGO_CHAR, file: LOGO_FILE,
    subtitle: 'ascii-full-serve · 一条链接，直接进播放器',
  });
}
const log = createLogger({ name: 'ascii-full-serve', dir: ROOT });
log.startup([
  ['目录', ROOT],
  ['端口', String(PORT)],
  ['监听', HOST + (LAN ? ' (局域网)' : ' (仅本机)')],
  ['产物', fs.existsSync(path.join(ROOT, 'meta.json')) ? 'meta.json ✓' : '⚠ 没找到 meta.json（转码可能还没跑完）'],
]);
log.stage('服务启动');

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400).end('Bad request'); return; }

  if (pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, service: 'ascii-full-serve', root: ROOT, port: PORT }));
    return;
  }
  if (pathname === '/') pathname = '/player.html';

  const file = path.resolve(ROOT, '.' + pathname);
  // 目录穿越防护
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden'); return;
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      if (pathname === '/player.html') {
        res.writeHead(404, { 'Content-Type': MIME['.html'] });
        res.end('<!doctype html><meta charset="utf-8"><p>产物目录里没有 player.html。<br>' +
          '重跑一次转码（会自动复制），或手动 cp web/player.html 到产物目录。</p>');
      } else { res.writeHead(404).end('Not found'); }
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const baseHeaders = {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
      // 故意不写 Content-Encoding: gzip
    };

    // <audio> 在拖进度 / 起播时会发 Range: bytes=…，不回 206 会拖不动。
    // 对 .gz 无影响：播放器的 fetch 不带 Range，仍走下面 200 整块。
    const range = req.headers.range;
    const m = range && /^bytes=\d*-\d*$/.test(range) ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (!m[1] && m[2]) {                       // bytes=-500 后缀形式
        const suffix = parseInt(m[2], 10);
        start = Math.max(0, st.size - suffix);
        end = st.size - 1;
      }
      end = Math.min(end, st.size - 1);
      if (!Number.isFinite(start) || start >= st.size || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
        return;
      }
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
      });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
      return;
    }

    res.writeHead(200, { ...baseHeaders, 'Content-Length': st.size });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  const local = `http://127.0.0.1:${PORT}/`;
  const lan = lanIPs().map(x => `http://${x.address}:${PORT}/`);
  const primary = PUBLIC ? String(PUBLIC).replace(/\/+$/, '') + '/' : local;

  console.log('  ── 打开这条链接 ──────────────────────────');
  console.log(`  ▸ ${primary}`);
  if (PUBLIC) console.log(`    本机备用  ${local}`);
  if (LAN && lan.length) for (const u of lan.slice(0, 2)) console.log(`    局域网    ${u}`);
  console.log('  ──────────────────────────────────────────');
  console.log('  根路径直接进播放器，不用补 /player.html');
  console.log('  Ctrl-C 退出\n');

  // 把可点的链接也写进产物目录，方便从别处复制 / 扫码
  try { fs.writeFileSync(path.join(ROOT, 'open.url'), primary + '\n'); } catch {}

  log.info('listening on ' + primary + '  [bind ' + HOST + ':' + PORT + ']');
  if (AUTO_OPEN) {
    const cmd = openURL(primary);
    log.info('自动打开: ' + (cmd || '失败'));
  }
});

process.on('SIGINT', () => { log.info('收到 Ctrl-C，退出'); server.close(() => process.exit(0)); });
