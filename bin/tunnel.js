#!/usr/bin/env node
/*
 * ascii-full-tunnel —— 把本地播放器临时映射成一个 https 域名链接
 *
 *   ascii-full-tunnel 8080                    # 默认走 SSH 反向转发，零安装
 *   ascii-full-tunnel 8080 --provider cloudflared   # 走 443，22 端口被掐时用
 *   ascii-full-tunnel 8080 --open            # 拿域名后自动拉起浏览器
 *   ascii-full-tunnel 8080 --hostname ascii.de5.net  # 打印「固定域名」绑定步骤
 *
 * 注意：这是**串流**，不上传 171MB 产物；手机要一直开机、服务不能停。
 * 播放器按 60 帧/块按需取，首次只拉当前那块，不会一次拉全片。
 *
 * ⚠ 绑自定义域时必须给该子域单独放行 Under Attack Mode / 降低 Security Level：
 *   fetch('chunks/*.gz') 不执行 JS，会被 CF challenge 静默挡掉，页面表现为「白屏」。
 *   跟 <video src> 被 UAM 挡是同一个坑。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { print: printBanner } = require('./banner');

const argv = process.argv.slice(2);
function opt(n, d) {
  const i = argv.indexOf('--' + n);
  if (i < 0) return d;
  if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) return true;
  return argv[i + 1];
}
const FLAG = n => argv.includes('--' + n);
const PORT = parseInt(argv.find(a => /^\d+$/.test(a)) || '8080', 10);
const PROVIDER = String(opt('provider', 'ssh'));
const HOSTNAME = opt('hostname', null);
const AUTO_OPEN = FLAG('open');
const LOGO = String(opt('logo', 'TUNNEL'));
const URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*(?:\.trycloudflare\.com|\.lhr\.life|\.localhost\.run)/i;

const HELP = `ascii-full-tunnel —— 把本地端口变成 https 域名

用法: ascii-full-tunnel [端口] [选项]

  端口                 默认 8080（跟 ascii-full-serve 保持一致）
  --provider ssh       默认。零安装，走 SSH 反向转发（22 端口要通）
  --provider cloudflared   走 443/HTTPS，22 被掐时用；需要 cloudflared
  --hostname 域名      不建临时隧道，只打印「固定域名」绑定步骤
  --open               拿到域名后自动拉起浏览器（Termux 用 termux-open-url）
  --logo "TEXT"        启动大字
  --no-logo            关掉大字

先起服务:  ascii-full-serve ./ascii-out 8080
再开隧道:  ascii-full-tunnel 8080 --open
Ctrl-C 关闭隧道；服务别停。
`;

if (FLAG('help')) { console.log(HELP); process.exit(0); }

function isTermux() {
  return !!(process.env.TERMUX_VERSION || (process.env.PREFIX || '').includes('com.termux'));
}
function openURL(url) {
  const cmd = isTermux() ? 'termux-open-url'
    : process.platform === 'win32' ? 'cmd'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch {}
}

function announce(url) {
  console.log('\n  ── 公网链接（可直接发给别人）──────────────');
  console.log(`  ▸ ${url}/`);
  console.log('  ──────────────────────────────────────────');
  console.log('  本机 ' + `http://127.0.0.1:${PORT}/` + ' 仍然可用');
  console.log('  Ctrl-C 关闭；ascii-full-serve 别停\n');
  try { fs.writeFileSync(path.join(process.cwd(), 'tunnel.url'), url + '/\n'); } catch {}
  console.log('  已写入 ./tunnel.url，也给 serve 加 --public ' + url + ' 让横幅显示域名');
  if (AUTO_OPEN) openURL(url + '/');
}

function fixedDomain() {
  console.log('\n  固定域名绑定（一次性，需 Cloudflare 账号）:');
  console.log(`  1) cloudflared tunnel login`);
  console.log(`  2) cloudflared tunnel create ascii-full`);
  console.log(`  3) cloudflared tunnel route dns ascii-full ${HOSTNAME}`);
  console.log(`  4) cloudflared tunnel run --url http://127.0.0.1:${PORT} ascii-full`);
  console.log(`\n  然后:  ascii-full-serve ./ascii-out ${PORT} --public https://${HOSTNAME}`);
  console.log('\n  ⚠ 关键：在 CF 控制台给 ' + HOSTNAME + ' 单独放行 Under Attack Mode');
  console.log('    （或把 Security Level 降到 Medium 以下）。');
  console.log('    fetch("chunks/*.gz") 不执行 JS，UAM 会静默挡掉，页面只白屏。');
  console.log('    你之前 <video src> 在 ccwu.cc 上踩的就是同一个坑。\n');
  process.exit(0);
}

if (!FLAG('no-logo')) {
  printBanner({ title: LOGO, subtitle: `ascii-full-tunnel · ${PROVIDER} · port ${PORT}` });
}

if (HOSTNAME) fixedDomain();

let cmd, args;
if (PROVIDER === 'cloudflared') {
  const probe = spawnSync('cloudflared', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    console.error('✗ 没找到 cloudflared。Termux 上先试:');
    console.error('    pkg install cloudflared');
    console.error('  源里没有就去 Cloudflare GitHub releases 取 linux-arm64 二进制，');
    console.error('  改名为 cloudflared 放到 $PREFIX/bin/ 并 chmod +x。');
    console.error('  或改用默认的 --provider ssh（零安装）。');
    process.exit(1);
  }
  cmd = 'cloudflared';
  args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`];
} else if (PROVIDER === 'ssh') {
  const probe = spawnSync('ssh', ['-V'], { encoding: 'utf8' });
  if (probe.error) { console.error('✗ 没找到 ssh'); process.exit(1); }
  cmd = 'ssh';
  args = ['-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=30',
    '-R', `80:127.0.0.1:${PORT}`, 'nokey@localhost.run'];
} else {
  console.error('✗ --provider 只支持 ssh / cloudflared');
  process.exit(1);
}

console.log(`  启动 ${cmd} ${args.join(' ')}`);
console.log('  等域名分配（通常 2~10 秒）…\n');

const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let got = false;
const onLine = buf => {
  for (const line of buf.toString().split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(URL_RE);
    if (m && !got) { got = true; announce(m[0]); }
    else if (/error|failed|refused|permission denied/i.test(line) && !got) {
      process.stderr.write('  ' + line.trim() + '\n');
    } else if (!got) {
      process.stderr.write('  · ' + line.trim().slice(0, 120) + '\n');
    }
  }
};
child.stdout.on('data', onLine);
child.stderr.on('data', onLine);
child.on('error', e => { console.error('✗ 启动失败: ' + e.message); process.exitCode = 1; });
child.on('exit', code => {
  if (!got) {
    console.error('\n✗ 没拿到域名就退出了 (code ' + code + ')。');
    if (PROVIDER === 'ssh') console.error('  多半是 22 端口被掐 → 换 --provider cloudflared（走 443）。');
  }
});
process.on('SIGINT', () => { child.kill('SIGINT'); process.exit(0); });
