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
const { check: checkCore } = require(path.join(ROOT, 'test', 'core.test.js'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ascii-full-test-'));
let passed = 0;

function ok(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ✓ ' + msg); passed++;
}
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, r => {
      const chunks = [];
      r.on('data', d => chunks.push(d));
      r.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: r.statusCode, headers: r.headers,
          bytes: body.length, text: body.toString('utf8') });
      });
    }).on('error', reject);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('— 渲染等价性（无 ffmpeg 依赖）—');
  checkRender(ok);
  console.log('— v1.5 渲染核心：色域 / ramp / WebGL 图集（无 DOM 依赖）—');
  checkCore(ok);

  // 0-A. 桌面端 / CLI 参数同步（静态，无 ffmpeg 也能跑）
  // 教训：CLI 加了 --audio 等开关，GUI 曾漏同步半个版本。这里把「必须一起改」
  // 固化成断言，本地 npm test 与 CI 都会拦住。
  const rd = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
  console.log('— 桌面端参数同步（静态）—');
  const dm = rd('desktop/main.js');
  const dh = rd('desktop/renderer/index.html');
  const da = rd('desktop/renderer/app.js');
  const dp = JSON.parse(rd('desktop/package.json'));
  const rootPkg = JSON.parse(rd('package.json'));
  ok(dp.version === rootPkg.version, `desktop 版本 ${dp.version} 与根 ${rootPkg.version} 一致`);
  for (const flag of ["'--audio'", "'--audio-codec'", "'--audio-bitrate'", "'--audio-id'", "'--cols'", "'--interp'"]) {
    ok(dm.includes(flag), `desktop/main.js 透传 ${flag}`);
  }
  ok(dm.includes("'.webm': 'audio/webm'") && dm.includes('writeHead(206'), '桌面内置服务有音频 MIME 与 Range(206)');
  const svSrc = rd('bin/serve.js');
  ok(svSrc.includes("'.webm': 'audio/webm'") && svSrc.includes('writeHead(206'), 'bin/serve.js 同样支持 Range(206)');
  for (const id of ['id="audio"', 'id="audioCodec"', 'id="audioBitrate"', 'id="audioId"', 'id="cols"', 'id="interp"']) {
    ok(dh.includes(id), `界面有 ${id} 控件`);
  }
  for (const key of ['audioCodec:', 'audioBitrate:', 'audioId:', 'cols:', 'interp:', 'audio:']) {
    ok(da.includes(key), `app.js collect() 收集 ${key}`);
  }
  ok(dm.includes("args.push(cols ? '--cols' : '--grid'"), 'cols 与 grid 互斥传参（超采样不压扁）');
  ok(da.includes('syncAudio()'), '音频控件有启用联动');

  console.log('ascii字符画视频 · 自检\n');

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

  // 4e. 入口形态：根路径直出 / Termux 自动打开 / 公网域名 / 远程 src
  ok(pl.includes("QS.get('src')") && pl.includes('urlOf('), '播放器支持 ?src= 远程域名前缀');
  const sv = fs.readFileSync(path.join(ROOT, 'bin', 'serve.js'), 'utf8');
  ok(sv.includes('termux-open-url') && sv.includes('networkInterfaces'),
    'serve 支持 Termux 自动拉起浏览器与局域网 IP 枚举');
  ok(sv.includes('--public') && sv.includes("'/health'"), 'serve 支持 --public 域名与 /health');
  ok(sv.includes("pathname === '/favicon.ico'"), 'serve 静默处理 favicon（不再刷 404）');
  const tn = fs.readFileSync(path.join(ROOT, 'bin', 'tunnel.js'), 'utf8');
  ok(tn.includes('--provider cloudflared') && tn.includes('nokey@localhost.run') &&
    /trycloudflare/.test(tn) && /lhr\\?\.life/.test(tn),
    'tunnel 同时支持 cloudflared 与 SSH 两种 https 域名');
  ok(tn.includes('Under Attack Mode'), 'tunnel 明确写出 UAM 会挡掉 .gz 的坑');
  ok(fs.existsSync(path.join(ROOT, 'docs', 'URLS.md')), '文档 docs/URLS.md 存在');
  const th = run(process.execPath, [path.join(ROOT, 'bin', 'tunnel.js'), '--help']);
  ok(th.status === 0 && th.stdout.includes('--provider'), 'tunnel --help 可用且不联网');

  // 4f. 旁路音轨 / 多轨叠加 / 不重转补音轨 -------------------------------
  const crypto = require('crypto');
  const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const ATTACH = path.join(ROOT, 'bin', 'attach-audio.js');
  ok(fs.existsSync(ATTACH), 'bin/attach-audio.js 存在');
  const ah = run(process.execPath, [ATTACH, '--help']);
  ok(ah.status === 0 && ah.stdout.includes('--file') && ah.stdout.includes('--list'),
    'attach-audio --help 可用且不联网');

  // 带 440Hz 音轨的测试片（sample.mp4 是纯画面，正好用来测「无音轨」分支）
  const sampleA = path.join(TMP, 'sample-audio.mp4');
  let ga = run('ffmpeg', ['-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k',
    '-shortest', '-y', sampleA]);
  if (ga.status !== 0) {
    ga = run('ffmpeg', ['-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-shortest', '-y', sampleA]);
  }
  ok(ga.status === 0 && fs.existsSync(sampleA), '合成带音轨测试片 (AAC 440Hz)');

  const outA = path.join(TMP, 'out-audio');
  const ra = run(process.execPath, [BIN, '--src', sampleA, '--out', outA,
    '--grid', '20', '--to', '1', '--chunk', '12', '--audio', '--force']);
  ok(ra.status === 0, '--audio 转码退出码 0' + (ra.status !== 0 ? '\n' + ra.stderr : ''));
  const MA = JSON.parse(fs.readFileSync(path.join(outA, 'meta.json'), 'utf8'));
  ok(MA.audio && MA.audio.version === 1 && MA.audio.master === 0, 'meta.audio 结构 / master=0');
  ok(Array.isArray(MA.audio.tracks) && MA.audio.tracks.length === 1, '一条主音轨，且是 tracks[] 数组');
  const T0 = MA.audio.tracks[0];
  ok(T0.id === 'main' && T0.file === 'audio/main.webm' && T0.codec === 'opus',
    'track 基础字段：id / file / codec');
  ok(String(T0.mime).includes('opus') && T0.role === 'master' && T0.source === 'video',
    'track 带 mime / role / source');
  ok(T0.gain === 1 && T0.offset === 0 && T0.srcStart === 0, 'track 默认 gain / offset / srcStart');
  ok(fs.existsSync(path.join(outA, 'audio', 'main.webm')) &&
     fs.statSync(path.join(outA, 'audio', 'main.webm')).size > 0, 'audio/main.webm 已落盘且非空');
  const apb = run('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate', '-of', 'default=nw=1',
    path.join(outA, 'audio', 'main.webm')]);
  ok(apb.status === 0 && apb.stdout.includes('opus'), '抽出的音轨确实是 Opus（ffprobe 验证）');
  ok(MA.frameBytes === MA.W * MA.H * 4 && MA.frames >= 20, '带音频时画面帧格式完全不变');

  const outNA = path.join(TMP, 'out-noaudio');
  const rna = run(process.execPath, [BIN, '--src', sample, '--out', outNA,
    '--grid', '20', '--to', '0.3', '--audio', '--force']);
  ok(rna.status === 0, '源片无音轨时 --audio 不报错（静音降级）');
  const MNA = JSON.parse(fs.readFileSync(path.join(outNA, 'meta.json'), 'utf8'));
  ok(MNA.audio && MNA.audio.tracks.length === 0, '无音轨 → tracks=[]，产物静音但可后挂');
  const outNo = path.join(TMP, 'out-no-audio');
  const rno = run(process.execPath, [BIN, '--src', sampleA, '--out', outNo,
    '--grid', '20', '--to', '0.3', '--audio', '--no-audio', '--force']);
  ok(rno.status === 0 && !JSON.parse(fs.readFileSync(path.join(outNo, 'meta.json'), 'utf8')).audio,
    '--no-audio 优先，meta 完全不含 audio（老格式）');

  // 给第 2 节的产物补音轨：chunks 一个字节都不能变
  // 故意把播放器换成 v1.3 老版，验证「补完音轨不会仍然没声音」
  const chunkBefore = hash(path.join(out, 'chunks', 'c_00000.gz'));
  fs.writeFileSync(path.join(out, 'player.html'), '<html>legacy player v1.3</html>');
  const at1 = run(process.execPath, [ATTACH, '--out', out, '--src', sampleA, '--id', 'main']);
  ok(at1.status === 0, 'attach-audio 给已有产物补主音轨' + (at1.status !== 0 ? '\n' + at1.stderr : ''));
  const M1 = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'));
  ok(M1.audio.tracks.length === 1 && M1.audio.tracks[0].source === 'video', '补的轨写进 meta');
  ok(fs.readFileSync(path.join(out, 'player.html'), 'utf8').includes('meta.audio'),
    '补音轨自动把老播放器升级成支持音频的版本');
  ok(hash(path.join(out, 'chunks', 'c_00000.gz')) === chunkBefore, '补音轨后 chunks 逐字节不变');

  const wav = path.join(TMP, 'bgm.wav');
  const gw = run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=660:duration=1', '-ac', '2', '-ar', '44100',
    '-c:a', 'pcm_s16le', '-y', wav]);
  ok(gw.status === 0 && fs.existsSync(wav), '合成外部 BGM wav');
  const at2 = run(process.execPath, [ATTACH, '--out', out, '--file', wav,
    '--id', 'bgm', '--gain', '0.6', '--offset', '1.5']);
  ok(at2.status === 0, 'attach-audio --file 直接挂外部音频（不重编码）');
  const M2 = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'));
  ok(M2.audio.tracks.length === 2, '两路音轨叠加成功');
  const bgm = M2.audio.tracks.find(t => t.id === 'bgm');
  ok(bgm && bgm.source === 'file' && bgm.gain === 0.6 && bgm.offset === 1.5,
    '叠加轨带 source / gain / offset');
  ok(fs.existsSync(path.join(out, 'audio', 'bgm.wav')), 'audio/bgm.wav 已落盘');
  ok(hash(path.join(out, 'chunks', 'c_00000.gz')) === chunkBefore, '第二路音轨仍不碰 chunks');

  const ls = run(process.execPath, [ATTACH, '--out', out, '--list']);
  ok(ls.status === 0 && ls.stdout.includes('main') && ls.stdout.includes('bgm'), '--list 列出两路');
  const ms = run(process.execPath, [ATTACH, '--out', out, '--master', 'bgm']);
  ok(ms.status === 0 && JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8')).audio.master === 1,
    '--master 换主时钟');
  const rm = run(process.execPath, [ATTACH, '--out', out, '--remove', 'bgm']);
  const M3 = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'));
  ok(rm.status === 0 && M3.audio.tracks.length === 1 &&
     !fs.existsSync(path.join(out, 'audio', 'bgm.wav')), '--remove 删轨连文件');
  ok(hash(path.join(out, 'chunks', 'c_00000.gz')) === chunkBefore, '--remove 不碰 chunks');

  // --force 重转画面：转码器自己抽的轨清掉，用户 --file 挂的轨原样继承
  run(process.execPath, [ATTACH, '--out', out, '--file', wav, '--id', 'bgm', '--gain', '0.5']);
  const rf = run(process.execPath, [BIN, '--src', sample, '--out', out,
    '--grid', '20', '--to', '1', '--chunk', '12', '--force']);
  ok(rf.status === 0, '--force 重转画面退出码 0');
  const M4 = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'));
  const keep = M4.audio && M4.audio.tracks.find(t => t.id === 'bgm');
  ok(keep && keep.source === 'file' && keep.gain === 0.5, '--force 继承外部叠加轨（不用重挂）');
  ok(fs.existsSync(path.join(out, 'audio', 'bgm.wav')), '继承轨的音频文件仍在');
  ok(!fs.existsSync(path.join(out, 'audio', 'main.webm')), '转码器自己抽的旧音轨已被清理');

  // 播放器 / 服务 / 文档静态校验
  ok(pl.includes('masterEl.currentTime + offsetSec') && pl.includes('M.audio'),
    '播放器用音频主时钟换算帧索引，且读 meta.audio');
  ok(pl.includes('setMuted') && pl.includes('audioPlay') && pl.includes("QS.get('mute')") &&
     pl.includes("QS.get('offset')"), '播放器有静音解锁 / ?mute / ?offset');
  ok(sa.includes('audioFiles') && sa.includes('masterEl.currentTime') && sa.includes('setupAudio'),
    'standalone 同步支持多轨与音频主时钟');
  ok(sv.includes("'.webm': 'audio/webm'") && sv.includes("'Accept-Ranges'"),
    'serve 补了音频 MIME、Range 与 Accept-Ranges');
  const fm = fs.readFileSync(path.join(ROOT, 'docs', 'FORMAT.md'), 'utf8');
  ok(fm.includes('audio.tracks') && fm.includes('HTTP Range') && fm.includes('currentTime'),
    'FORMAT.md 写明 audio.tracks[] 与时钟换算');
  ok(fs.existsSync(path.join(ROOT, 'docs', 'AUDIO.md')) &&
     fs.readFileSync(path.join(ROOT, 'docs', 'AUDIO.md'), 'utf8').includes('多轨'),
    'docs/AUDIO.md 存在且讲了多轨叠加');

  // 4g. v1.5：自定义字形表 / 色域协商 / WebGL 图集 -------------------------
  const coreSrc = fs.readFileSync(path.join(ROOT, 'web', '_render-core.js'), 'utf8');
  const grab = s => { const m = /<script id="render-core">([\s\S]*?)<\/script>/.exec(s); return m ? m[1] : ''; };
  const c1 = grab(pl), c2 = grab(sa);
  ok(c1.includes('AsciiFullCore') && c2.includes('AsciiFullCore'), '两个播放器都内联了渲染核心');
  ok(c1.includes(coreSrc) && c2.includes(coreSrc),
    '内联核心与 web/_render-core.js 逐字一致（不是各写一份）');
  ok(pl.includes('GlyphGL') && sa.includes('GlyphGL'), '两个播放器都接 WebGL 字形图集路径');
  ok(pl.includes('gamutPlan') && sa.includes('gamutPlan'), '两个播放器都做色域协商');
  ok(pl.includes("get('nogl')") && sa.includes("get('nogl')"), '两个播放器都有 ?nogl=1 回退开关');
  const cli = fs.readFileSync(BIN, 'utf8');
  ok(cli.includes("--ramp-file") && cli.includes('--gamut'), '转码器有 --ramp-file / --gamut');
  ok(cli.includes('color_primaries') && cli.includes('COLOR_INFO'), '转码器探测源片色域标记并写 meta.color');
  ok(run(process.execPath, [BIN, '--help']).stdout.includes('--ramp-file'), '--help 列出自定义 ramp 用法');
  for (const flag of ["'--ramp-file'", "'--gamut'"]) ok(dm.includes(flag), `desktop/main.js 透传 ${flag}`);
  for (const key of ['rampFile:', 'gamut:']) ok(da.includes(key), `app.js collect() 收集 ${key}`);
  for (const id of ['id="rampFile"', 'id="gamut"']) ok(dh.includes(id), `界面有 ${id} 控件`);
  ok(fs.existsSync(path.join(ROOT, 'scripts', 'gen-ramp.py')) &&
     fs.existsSync(path.join(ROOT, 'docs', 'RAMP.md')) &&
     fs.existsSync(path.join(ROOT, 'docs', 'COLOR.md')), 'ramp 生成脚本与两份文档齐备');
  const fm5 = fs.readFileSync(path.join(ROOT, 'docs', 'FORMAT.md'), 'utf8');
  ok(fm5.includes('rampSpec') && fm5.includes('meta.color'), 'FORMAT.md 写明两个新旁路字段');

  const py = run('python3', ['-c', 'import fontTools, PIL']);
  if (py.status !== 0) {
    console.log('  ⚠ 跳过 gen-ramp 实跑（缺 fonttools / pillow），静态断言仍全部执行');
  } else {
    const rampDir = path.join(TMP, 'ramp');
    const gr = run('python3', [path.join(ROOT, 'scripts', 'gen-ramp.py'),
      '--levels', '24', '--limit', '400', '--tile', '16', '--out', rampDir]);
    ok(gr.status === 0, 'gen-ramp.py 实跑成功' + (gr.status !== 0 ? '\n' + gr.stderr : ''));
    const rj = JSON.parse(fs.readFileSync(path.join(rampDir, 'ramp.json'), 'utf8'));
    ok(rj.levels.length === 24 && rj.atlas.cols * rj.atlas.rows >= 24,
      'ramp.json: 24 级且图集网格放得下');
    ok(rj.levels[0].char === ' ', 'ramp.json: 0 级是空格（索引 0 = 不画）');
    ok(rj.levels.every(l => l.char.length === 1), 'ramp.json: 每个字都是 1 个 UTF-16 单元（无 emoji）');
    ok(fs.statSync(path.join(rampDir, 'ramp-atlas.png')).size > 0, 'ramp-atlas.png 已生成且非空');

    const out5 = path.join(TMP, 'out-v15');
    const r5 = run(process.execPath, [BIN, '--src', sample, '--out', out5,
      '--grid', '20', '--to', '0.3', '--chunk', '12', '--force',
      '--ramp-file', path.join(rampDir, 'ramp.json'), '--gamut', 'expand']);
    ok(r5.status === 0, '--ramp-file + --gamut 转码退出码 0' + (r5.status !== 0 ? '\n' + r5.stderr : ''));
    const M5 = JSON.parse(fs.readFileSync(path.join(out5, 'meta.json'), 'utf8'));
    ok(M5.ramp.length === 24 && M5.rampSpec && M5.rampSpec.count === 24,
      'meta.ramp 换成 24 级自定义表，rampSpec.count 一致');
    ok(M5.rampSpec.atlas.file === 'ramp-atlas.png' && M5.rampSpec.atlas.cols * M5.rampSpec.atlas.rows >= 24,
      'meta.rampSpec.atlas 图集布局可用');
    ok(!('srcAtlasDir' in M5.rampSpec), 'meta 里不泄漏本机绝对路径');
    ok(M5.color && M5.color.gamut === 'p3' && M5.color.source === 'expand', '--gamut expand → p3 声明');
    ok(fs.existsSync(path.join(out5, 'ramp.json')) && fs.existsSync(path.join(out5, 'ramp-atlas.png')),
      'ramp.json / ramp-atlas.png 已复制进产物目录');
    ok(M5.frameBytes === M5.W * M5.H * 4 && M5.bytesPerCell === 4,
      '换表 + 换色域后 chunks 仍是 4B/cell，格式一字节没动');
    const c5 = zlib.gunzipSync(fs.readFileSync(path.join(out5, 'chunks', 'c_00000.gz')));
    let idxMax = 0;
    for (let i = 0; i < Math.min(M5.chunkFrames, M5.frames); i++) idxMax = Math.max(idxMax, c5[i * M5.frameBytes]);
    ok(idxMax < 24, `索引按新表重新量化（实测最大 ${idxMax} < 24）`);

    // 用户常把两个旁路文件直接解压进产物目录再当 --ramp-file 用；
    // --force 不能把源文件自删，也不能同路径 copyFileSync 失败。
    const selfDir = path.join(TMP, 'out-self');
    fs.mkdirSync(selfDir, { recursive: true });
    fs.copyFileSync(path.join(rampDir, 'ramp.json'), path.join(selfDir, 'ramp.json'));
    fs.copyFileSync(path.join(rampDir, 'ramp-atlas.png'), path.join(selfDir, 'ramp-atlas.png'));
    const rs = run(process.execPath, [BIN, '--src', sample, '--out', selfDir,
      '--grid', '20', '--to', '0.2', '--chunk', '12', '--force',
      '--ramp-file', path.join(selfDir, 'ramp.json')]);
    ok(rs.status === 0, 'ramp 源文件与 --out 同目录 + --force 不崩' + (rs.status !== 0 ? '\n' + rs.stderr : ''));
    ok(fs.existsSync(path.join(selfDir, 'ramp.json')) &&
       fs.existsSync(path.join(selfDir, 'ramp-atlas.png')),
      '同目录 --force 后两个旁路文件仍在（从内存写回）');
    const Ms = JSON.parse(fs.readFileSync(path.join(selfDir, 'meta.json'), 'utf8'));
    ok(Ms.rampSpec && Ms.rampSpec.count === 24, '同目录 --force 后 meta.rampSpec 仍正确');

    const out6 = path.join(TMP, 'out-auto');
    const r6 = run(process.execPath, [BIN, '--src', sample, '--out', out6,
      '--grid', '20', '--to', '0.2', '--force']);
    ok(r6.status === 0, '默认 --gamut auto 转码退出码 0');
    const M6 = JSON.parse(fs.readFileSync(path.join(out6, 'meta.json'), 'utf8'));
    ok(M6.color && M6.color.gamut === 'srgb' && M6.color.source === 'probe',
      'BT.709 / 未标注的 SDR 片 auto 如实写 srgb，不凭空升 P3');
    ok(!M6.rampSpec && M6.ramp.length === 70, '不给 --ramp-file 时仍走内置 70 级（老产物零回归）');

    // 非法输入必须挡住，不能悄悄产出坏数据
    const badDir = path.join(TMP, 'bad-ramp');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'ramp.json'), JSON.stringify({
      levels: [{ char: ' ', coverage: 0 }, { char: '\u{1F600}', coverage: 1 }], atlas: { file: 'ramp-atlas.png' }
    }));
    const rb = run(process.execPath, [BIN, '--src', sample, '--out', path.join(TMP, 'out-bad'),
      '--to', '0.1', '--force', '--ramp-file', path.join(badDir, 'ramp.json')]);
    ok(rb.status !== 0 && /UTF-16/.test(rb.stderr), '非 BMP 字形（emoji）被拒绝，避免 ramp 索引错位');
    const rg = run(process.execPath, [BIN, '--src', sample, '--out', path.join(TMP, 'out-bad2'),
      '--to', '0.1', '--force', '--gamut', 'bogus']);
    ok(rg.status !== 0 && /--gamut/.test(rg.stderr), '非法 --gamut 值被拒绝');
  }

  // 5. 内置 HTTP 服务
  return (async () => {
    const port = 18000 + Math.floor(Math.random() * 2000);
    const srv = spawn(process.execPath, [path.join(ROOT, 'bin', 'serve.js'), out, String(port)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    await sleep(500);
    try {
      const a = await get(`http://127.0.0.1:${port}/player.html`);
      const root = await get(`http://127.0.0.1:${port}/`);
      const fav = await get(`http://127.0.0.1:${port}/favicon.ico`);
      const health = await get(`http://127.0.0.1:${port}/health`);
      const b = await get(`http://127.0.0.1:${port}/meta.json`);
      const c = await get(`http://127.0.0.1:${port}/chunks/c_00000.gz`);
      const d = await get(`http://127.0.0.1:${port}/../../etc/passwd`);
      ok(a.status === 200 && a.bytes > 0, 'GET /player.html → 200');
      ok(root.status === 200 && root.text.includes('ascii-full'),
        'GET / 直接返回播放器（不用补 /player.html）');
      ok(fav.status === 204, 'GET /favicon.ico → 204（不再刷 404）');
      ok(health.status === 200 && JSON.parse(health.text).ok === true, 'GET /health → 200 JSON');
      ok(b.status === 200, 'GET /meta.json → 200');
      ok(c.status === 200 && c.bytes > 0, 'GET /chunks/c_00000.gz → 200');
      ok(!c.headers['content-encoding'], '.gz 不带 Content-Encoding（播放器自行解压）');
      ok(d.status === 404 || d.status === 403, '目录穿越被拦截');
      const wavPath = path.join(out, 'audio', 'bgm.wav');
      const wavSize = fs.statSync(wavPath).size;
      const aw = await get(`http://127.0.0.1:${port}/audio/bgm.wav`);
      ok(aw.status === 200 && aw.headers['content-type'] === 'audio/wav' &&
         aw.headers['accept-ranges'] === 'bytes', 'GET 音频 → 200 + 正确 MIME + Accept-Ranges');
      const rg = await get(`http://127.0.0.1:${port}/audio/bgm.wav`, { Range: 'bytes=0-99' });
      ok(rg.status === 206 && rg.bytes === 100 &&
         rg.headers['content-range'] === `bytes 0-99/${wavSize}` &&
         rg.headers['accept-ranges'] === 'bytes', 'GET 音频带 Range → 206 + Content-Range');
      const sfx = await get(`http://127.0.0.1:${port}/audio/bgm.wav`, { Range: 'bytes=-64' });
      ok(sfx.status === 206 && sfx.bytes === 64, 'Range 后缀形式 bytes=-64 → 206');
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

    // 7. v1.6 导出宣传片：真跑 ffmpeg 编码 + 真抽一帧验非黑
    // 教训：mock 亮过不等于真亮。这里不看 draw call，直接验输出像素。
    console.log('— v1.6 导出宣传片（端到端）—');
    const EXP = path.join(ROOT, 'bin', 'export-video.js');
    const runBuf = (cmd, args) => spawnSync(cmd, args, { maxBuffer: 64 * 1024 * 1024 });
    const eh = run(process.execPath, [EXP, '--help']);
    ok(eh.status === 0 && eh.stdout.includes('导出宣传片'), 'export-video --help 输出中文帮助');
    const rootPkg16 = JSON.parse(rd('package.json'));
    ok(rootPkg16.bin['ascii-full-export'] === 'bin/export-video.js',
      'package.json 注册 ascii-full-export 命令');
    ok(fs.existsSync(path.join(ROOT, 'docs', 'EXPORT.md')) &&
       rd('README.md').includes('导出宣传视频'), '中文导出文档与 README 章节齐全');

    const expFile = path.join(TMP, 'export.mp4');
    const rExp = run(process.execPath, [EXP, '--out', out, '--to', expFile,
      '--duration', '0.5', '--mode', 'glyph', '--no-audio', '--quiet']);
    ok(rExp.status === 0, '导出退出码 0' + (rExp.status !== 0 ? '\n' + rExp.stderr : ''));
    ok(fs.existsSync(expFile) && fs.statSync(expFile).size > 1000, '导出 mp4 落盘且非空');

    const pj = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries',
      'stream=codec_name,codec_type,width,height,pix_fmt,nb_frames',
      '-of', 'json', expFile]).stdout);
    const vs = (pj.streams || []).find(s => s.codec_type === 'video') || {};
    ok(vs.codec_name === 'h264' && vs.pix_fmt === 'yuv420p',
      '导出为 H.264 / yuv420p（视频网站通吃）');
    ok(vs.width === M.W * 8 && vs.height === M.H * 8 * 2,
      `输出尺寸按 cell 8×16 铺开 ${vs.width}×${vs.height}`);
    ok(parseInt(vs.nb_frames, 10) === 12, '导出帧数与 --duration 对齐（12 帧 @24fps）');
    ok(!(pj.streams || []).some(s => s.codec_type === 'audio'), '--no-audio 导出无音轨');

    const mp4 = fs.readFileSync(expFile);
    const moov = mp4.indexOf(Buffer.from('moov')), mdat = mp4.indexOf(Buffer.from('mdat'));
    ok(moov >= 0 && mdat >= 0 && moov < mdat, 'faststart：moov 在 mdat 之前（网页边下边播）');

    // 关键：真抽一帧看有没有东西，而不是只看编码成功
    const oneFrame = runBuf('ffmpeg', ['-v', 'error', '-i', expFile,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
    ok(oneFrame.status === 0 && oneFrame.stdout.length === vs.width * vs.height,
      '从导出 mp4 真抽出一帧灰度图');
    let lit = 0;
    for (const v of oneFrame.stdout) if (v > 8) lit++;
    ok(lit / oneFrame.stdout.length > 0.02,
      `抽帧非黑像素 ${(100 * lit / oneFrame.stdout.length).toFixed(1)}%（不产出全黑视频）`);

    // 强制网点降级也必须非黑
    const dithFile = path.join(TMP, 'export-dither.mp4');
    const rD = run(process.execPath, [EXP, '--out', out, '--to', dithFile,
      '--duration', '0.3', '--glyph', 'dither', '--no-audio', '--quiet']);
    ok(rD.status === 0, '--glyph dither 强制降级导出成功');
    const dFrame = runBuf('ffmpeg', ['-v', 'error', '-i', dithFile,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
    let dLit = 0;
    for (const v of dFrame.stdout) if (v > 8) dLit++;
    ok(dLit / dFrame.stdout.length > 0.02, '降级网点路径同样不黑屏');

    // 带音轨：多轨混合成一条 AAC
    const mixFile = path.join(TMP, 'export-mix.mp4');
    const rMix = run(process.execPath, [EXP, '--out', out, '--to', mixFile,
      '--duration', '0.3', '--quiet']);
    ok(rMix.status === 0, '带音轨导出成功' + (rMix.status !== 0 ? '\n' + rMix.stderr : ''));
    const pm = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=codec_name,channels', '-of', 'json', mixFile]).stdout);
    ok((pm.streams || []).length === 1 && pm.streams[0].codec_name === 'aac',
      '多轨混合成单条 AAC（宣传平台只认单轨）');

    // 坏输入必须挡住，不悄悄产出坏片
    const bad = run(process.execPath, [EXP, '--out', out, '--to', path.join(TMP, 'x.mp4'),
      '--font', '/definitely/not/a/font.ttf']);
    ok(bad.status !== 0 && bad.stderr.includes('--font'), '不存在的 --font 明确报错');
    const badGlyph = run(process.execPath, [EXP, '--out', out, '--to', path.join(TMP, 'x.mp4'),
      '--glyph', 'bogus']);
    ok(badGlyph.status !== 0 && badGlyph.stderr.includes('--glyph'), '非法 --glyph 被拒绝');

    console.log(`\n✓ ${passed} 项断言全部通过`);
  })();
}

main().catch(e => {
  console.error('\n✗ 烟测失败: ' + e.message);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
