#!/usr/bin/env node
/*
 * 零依赖端到端烟测：合成一段彩色测试片 → 转码 → 逐字节校验产物格式
 * → 校验 --half 分支 → 起本地服务发 HTTP → 校验终端播放器输出。
 *
 *   npm test      (或 node test/smoke.js)
 *
 * 需要 PATH 里有 ffmpeg / ffprobe；没有就明确跳过，不静默假装通过。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'ascii-full.js');
const { FONT, render, hasUnsupported } = require(path.join(ROOT, 'bin', 'banner.js'));
const { check: checkRender } = require(path.join(ROOT, 'test', 'render.test.js'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ascii-full-test-'));
let passed = 0;

function ok(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ✓ ' + msg); passed++;
}
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, r => {
      let n = 0;
      r.on('data', d => n += d.length);
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, bytes: n }));
    }).on('error', reject);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('— 渲染等价性（无 ffmpeg 依赖）—');
  checkRender(ok);

  console.log('ascii-full smoke test\n');

  // 0. 依赖
  const ff = run('ffmpeg', ['-version']);
  if (ff.error || ff.status !== 0) {
    console.error('⚠ 跳过：PATH 里没有可执行 ffmpeg。装好后再跑 npm test。');
    process.exit(0);
  }
  ok(true, 'ffmpeg 可执行');

  // 1. 合成 1 秒彩色测试片
  const sample = path.join(TMP, 'sample.mp4');
  let g = run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=320x180:rate=24:duration=1', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', '-y', sample]);
  if (g.status !== 0) {
    g = run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
      'testsrc=size=320x180:rate=24:duration=1', '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p', '-y', sample]);
  }
  ok(g.status === 0 && fs.existsSync(sample), '合成测试片 (320×180 / 24fps / 1s)');

  // 2. plain 模式
  const out = path.join(TMP, 'out');
  const r = run(process.execPath, [BIN, '--src', sample, '--out', out,
    '--grid', '20', '--to', '1', '--chunk', '12', '--force', '--logo', 'HELLO']);
  ok(r.status === 0, '转码退出码 0' + (r.status !== 0 ? '\n' + r.stderr : ''));
  ok(r.stdout.includes('#') && r.stdout.includes('开始解码'), '启动时打印 ASCII 大字与结构化日志');
  ok(fs.existsSync(path.join(out, 'ascii-full.log')), '日志落盘 ascii-full.log');
  ok(fs.readFileSync(path.join(out, 'ascii-full.log'), 'utf8').includes('开始解码'), '日志文件含阶段记录');

  const M = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'));
  const W = Math.round(2 * (320 / 180) * 20);
  ok(M.magic === 'ASCFULL1' && M.version === 1, 'meta magic/version');
  ok(M.W === W && M.H === 20, `网格按宽高比计算 ${M.W}×${M.H} (期望 ${W}×20)`);
  ok(Math.abs(M.fps - 24) < 0.001 && M.frames >= 20, `原生帧率 ${M.fps}fps / ${M.frames} 帧`);
  ok(M.ramp.length === 70 && M.bytesPerCell === 4 && M.colors === 1, '70 级 ramp / 每 cell 4B');
  ok(M.frameBytes === M.W * M.H * 4, 'frameBytes = W·H·4');
  ok(M.chunks === Math.ceil(M.frames / M.chunkFrames), `块数 ${M.chunks} = ceil(帧数/${M.chunkFrames})`);

  // 逐块 gunzip，校验裸字节数与索引范围
  let total = 0;
  for (let c = 0; c < M.chunks; c++) {
    const p = path.join(out, 'chunks', 'c_' + String(c).padStart(5, '0') + '.gz');
    const u8 = zlib.gunzipSync(fs.readFileSync(p));
    const take = Math.min(M.chunkFrames, M.frames - c * M.chunkFrames);
    ok(u8.length === take * M.frameBytes, `chunk ${c}: ${u8.length}B = ${take} 帧 × ${M.frameBytes}B`);
    for (let i = 0; i < take; i++) {
      const o = i * M.frameBytes;
      if (u8[o] >= M.ramp.length) throw new Error('ramp 索引越界 @chunk ' + c);
    }
    total += take;
  }
  ok(total === M.frames, `全部 ${total} 帧都有数据且 ramp 索引合法`);
  const ph = fs.readFileSync(path.join(out, 'player.html'), 'utf8');
  ok(ph.includes('ascii-full') && ph.includes('DecompressionStream'), 'player.html 已自动复制且自带 gzip 解压');
  ok(fs.existsSync(path.join(ROOT, 'web', 'player.html')), '仓库内 web/player.html 存在');
  // 缓存防回归：有界上限、命中挪末尾（真 LRU）、失败也清 pending
  ok(ph.includes('MAX_CACHE') && ph.includes('while (cache.size > MAX_CACHE)'), '播放器有有界缓存上限');
  ok(ph.includes('cache.delete(n); cache.set(n, hit)'), '播放器命中时刷新 LRU 顺序');
  ok(ph.includes('} finally {') && ph.includes('pending.delete(n)'), '失败路径也清 pending（允许重试）');
  const termSrc = fs.readFileSync(path.join(ROOT, 'bin', 'ascii-full-term.js'), 'utf8');
  ok(termSrc.includes('MAX_CACHE') && termSrc.includes('chunkCache.delete(n); chunkCache.set(n, hit)'), '终端播放器同样是有界 LRU');

  // 3. --half 分支
  const out2 = path.join(TMP, 'out-half');
  const r2 = run(process.execPath, [BIN, '--src', sample, '--out', out2,
    '--grid', '12', '--to', '0.3', '--half', '--force']);
  ok(r2.status === 0, '--half 转码退出码 0' + (r2.status !== 0 ? '\n' + r2.stderr : ''));
  const H2 = JSON.parse(fs.readFileSync(path.join(out2, 'meta.json'), 'utf8'));
  ok(H2.half === true && H2.colors === 2 && H2.bytesPerCell === 7, 'half: 上下双色 / 每 cell 7B');
  ok(H2.frameBytes === H2.W * H2.H * 7, 'half: frameBytes = W·H·7');
  const halfChunk = zlib.gunzipSync(fs.readFileSync(path.join(out2, 'chunks', 'c_00000.gz')));
  ok(halfChunk.length === Math.min(H2.chunkFrames, H2.frames) * H2.frameBytes, 'half: chunk 裸字节数正确');

  // 4. --help / --version
  const EXPECTED_VER = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  ok(run(process.execPath, [BIN, '--version']).stdout.includes(EXPECTED_VER), '--version 输出版本号 ' + EXPECTED_VER);
  ok(run(process.execPath, [BIN, '--help']).stdout.includes('--src'), '--help 含参数说明');
  ok(run(process.execPath, [BIN, '--help']).stdout.includes('--logo'), '--help 含启动大字参数');
  ok(run(process.execPath, [BIN]).status !== 0, '缺 --src 时非零退出');

  // 4b. ASCII 大字 / 日志模块
  const bad = Object.entries(FONT).filter(([, g]) => g.length !== 7 || g.some(r => r.length !== 5));
  ok(bad.length === 0, `5×7 点阵字体表完整（${Object.keys(FONT).length} 个字形）`);
  ok(render('ASCII FULL').split('\n').length === 7, 'render() 固定 7 行');
  const atArt = render('ABC', { char: '@' });
  ok(atArt.includes('@') && !atArt.includes('#'), '--logo-char 可换填充字符');
  ok(hasUnsupported('∞') && !hasUnsupported('ASCII FULL'), '非点阵字符能被识别并提示');
  const lg = run(process.execPath, [path.join(ROOT, 'bin', 'logger.js'), path.join(TMP, 'logtest')]);
  ok(lg.status === 0 && /\[\d{4}-\d\d-\d\d/.test(lg.stdout), 'logger 自检输出带时间戳');

  // 4c. 桌面版 / 免安装包 / 独立播放器 / Release 流水线文件齐备
  for (const f of [
    'desktop/main.js', 'desktop/preload.js', 'desktop/package.json',
    'desktop/electron-builder.yml', 'desktop/renderer/index.html', 'desktop/renderer/app.js',
    'web/standalone.html', 'scripts/build-portable.sh', '.github/workflows/release.yml',
  ]) ok(fs.existsSync(path.join(ROOT, f)), '文件存在 ' + f);
  const sa = fs.readFileSync(path.join(ROOT, 'web', 'standalone.html'), 'utf8');
  ok(sa.includes('webkitdirectory') && sa.includes('DecompressionStream'), 'standalone 支持目录选择与 gzip 自解压');
  ok(sa.includes('MAX_CACHE') && sa.includes('} finally {'), 'standalone 同样有有界 LRU 与失败重试');
  const rel = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  ok(rel.includes('build-portable.sh') && rel.includes('npm run build') && rel.includes('SHA256SUMS'),
    'release workflow 产出桌面版 + 免安装包 + 校验和');

  // 4d. 大画布缩放 / 亮度 / --cols 超采样
  const pl = fs.readFileSync(path.join(ROOT, 'web', 'player.html'), 'utf8');
  ok(pl.includes('BASE_CW = 8') && pl.includes('ZOOMS'), '播放器默认 8px/字且有分级缩放表');
  ok(pl.includes('touchmove') && pl.includes('pointermove'), '播放器支持双指缩放与拖动平移');
  ok(pl.includes('zfit') && pl.includes('gain'), '播放器有「适应」与亮度增益');
  ok(sa.includes('ZOOMS') && sa.includes('gain'), 'standalone 同步大画布与亮度');
  const out3 = path.join(TMP, 'out-cols');
  const r3 = run(process.execPath, [BIN, '--src', sample, '--out', out3,
    '--cols', '40', '--to', '0.2', '--force']);
  ok(r3.status === 0, '--cols 转码退出码 0' + (r3.status !== 0 ? '\n' + r3.stderr : ''));
  const C3 = JSON.parse(fs.readFileSync(path.join(out3, 'meta.json'), 'utf8'));
  ok(C3.W === 40 && C3.H > 8, '--cols 精确指定列数并按比例反算行数（不拉伸）');
  ok(C3.frameBytes === C3.W * C3.H * 4, '--cols 产物 frameBytes 正确');

  // 5. 内置 HTTP 服务
  return (async () => {
    const port = 18000 + Math.floor(Math.random() * 2000);
    const srv = spawn(process.execPath, [path.join(ROOT, 'bin', 'serve.js'), out, String(port)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    await sleep(500);
    try {
      const a = await get(`http://127.0.0.1:${port}/player.html`);
      const b = await get(`http://127.0.0.1:${port}/meta.json`);
      const c = await get(`http://127.0.0.1:${port}/chunks/c_00000.gz`);
      const d = await get(`http://127.0.0.1:${port}/../../etc/passwd`);
      ok(a.status === 200 && a.bytes > 0, 'GET /player.html → 200');
      ok(b.status === 200, 'GET /meta.json → 200');
      ok(c.status === 200 && c.bytes > 0, 'GET /chunks/c_00000.gz → 200');
      ok(!c.headers['content-encoding'], '.gz 不带 Content-Encoding（播放器自行解压）');
      ok(d.status === 404 || d.status === 403, '目录穿越被拦截');
    } finally { srv.kill(); }

    // 6. 终端播放器（跑一小会儿就 kill）
    const term = spawn(process.execPath,
      [path.join(ROOT, 'bin', 'ascii-full-term.js'), out, '--stride', '50'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    term.stdout.on('data', d => buf += d.toString());
    await sleep(600);
    term.kill('SIGINT');
    await sleep(100);
    ok(buf.includes('38;2;'), '终端播放器输出 truecolor 转义序列');
    ok(buf.includes('源片'), '终端播放器读到 meta.json');

    console.log(`\n✓ ${passed} 项断言全部通过`);
  })();
}

main().catch(e => {
  console.error('\n✗ 烟测失败: ' + e.message);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
