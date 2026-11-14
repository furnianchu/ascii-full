/*
 * ascii-full desktop —— 主进程
 *
 * 设计：GUI 只是命令行的图形外壳，转码仍跑同一份 bin/ascii-full.js。
 * 这样 CLI 的启动大字、结构化日志、所有参数行为在 GUI 里一字不差地复用，
 * 不会出现「桌面版和终端版结果不一样」。
 *
 * Electron 自带 Node，所以不需要用户安装 Node：用 ELECTRON_RUN_AS_NODE=1
 * 让自身进程去执行 CLI 脚本即可。ffmpeg/ffprobe 由 npm 包随应用打包。
 */
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

let win = null;
let playerWin = null;
let child = null;
let httpServer = null;

// 开发时 __dirname = <repo>/desktop；打包后 extraResources 放在 process.resourcesPath
const DEV = !app.isPackaged;
const RES = DEV ? path.join(__dirname, '..') : process.resourcesPath;
const CLI = path.join(RES, 'bin', 'ascii-full.js');
const WEB = path.join(RES, 'web');
const STANDALONE = path.join(WEB, 'standalone.html');
const PLAYER = path.join(WEB, 'player.html');

function unpack(p) {
  // asar 内的二进制不能直接执行，换成 app.asar.unpacked
  return p ? p.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1') : p;
}
function ffmpegBin() {
  try { return unpack(require('ffmpeg-static')) || 'ffmpeg'; }
  catch { return 'ffmpeg'; }
}
function ffprobeBin() {
  try { return unpack(require('ffprobe-static').path) || 'ffprobe'; }
  catch { return 'ffprobe'; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 900, minHeight: 620,
    backgroundColor: '#08070a',
    title: 'ascii-full · 真彩字符画工作台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.gz': 'application/octet-stream', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
};

/** 给产物目录起一个仅本机可访问的临时服务，供内置播放器窗口读取 .gz */
function serveDir(dir) {
  return new Promise((resolve, reject) => {
    if (httpServer) { try { httpServer.close(); } catch {} httpServer = null; }
    const root = path.resolve(dir);
    const srv = http.createServer((req, res) => {
      let p;
      try { p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
      catch { res.writeHead(400).end('Bad request'); return; }
      if (p === '/') p = '/player.html';
      const file = path.resolve(root, '.' + p);
      if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404).end('Not found'); return; }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Length': st.size, 'Cache-Control': 'no-store',
        });
        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
      });
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      httpServer = srv;
      resolve(`http://127.0.0.1:${srv.address().port}/player.html`);
    });
  });
}

function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => {
  if (child) { try { child.kill(); } catch {} }
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('app:info', () => ({
  version: (() => {
    try { return require('./package.json').version; } catch { return '1.2.0'; }
  })(),
  platform: process.platform + '-' + process.arch,
  electron: process.versions.electron,
  ffmpeg: ffmpegBin(),
  ffprobe: ffprobeBin(),
  cli: CLI,
  hasCli: fs.existsSync(CLI),
  hasPlayer: fs.existsSync(PLAYER),
}));

ipcMain.handle('dialog:pick-video', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择源视频', properties: ['openFile'],
    filters: [
      { name: '视频', extensions: ['mp4','mov','mkv','webm','avi','m4v','ts','flv'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:pick-dir', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择输出目录', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('standalone:save', async () => {
  if (!fs.existsSync(STANDALONE)) return { ok:false, error:'找不到 standalone.html' };
  const r = await dialog.showSaveDialog(win, {
    title: '导出独立播放器', defaultPath: 'ascii-full-standalone.html',
    filters: [{ name: 'HTML', extensions: ['html'] }],
  });
  if (r.canceled || !r.filePath) return { ok:false, canceled:true };
  fs.copyFileSync(STANDALONE, r.filePath);
  shell.showItemInFolder(r.filePath);
  return { ok:true, path:r.filePath };
});

ipcMain.handle('run:transcode', (_e, o) => {
  if (child) return { started:false, error:'已有任务在跑' };
  if (!fs.existsSync(CLI)) return { started:false, error:'找不到转码器：' + CLI };
  const args = [
    CLI,
    '--src', o.src, '--out', o.out,
    '--grid', String(o.grid || 60),
    '--chunk', String(o.chunk || 60),
    '--ramp', String(o.ramp || '70'),
    '--ffmpeg', ffmpegBin(), '--ffprobe', ffprobeBin(),
    '--logo', String(o.logo || 'ASCII FULL'),
    '--logo-char', String(o.logoChar || '#'),
  ];
  if (o.logoFile) args.push('--logo-file', o.logoFile);
  if (o.noLogo) args.push('--no-logo');
  if (o.fps) args.push('--fps', String(o.fps));
  if (o.from !== '' && o.from != null) args.push('--from', String(o.from));
  if (o.to !== '' && o.to != null) args.push('--to', String(o.to));
  if (o.half) args.push('--half');
  if (o.force) args.push('--force');

  emit('log:line', '$ ascii-full ' + args.slice(1).join(' '));
  child = spawn(process.execPath, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pump = (stream) => {
    let carry = '';
    stream.on('data', d => {
      carry += d.toString();
      const parts = carry.split(/[\r\n]+/);
      carry = parts.pop();
      for (const line of parts) if (line.length) emit('log:line', line);
    });
  };
  pump(child.stdout); pump(child.stderr);
  child.on('error', e => emit('log:line', '✗ 启动失败: ' + e.message));
  child.on('close', code => {
    child = null;
    emit('log:line', code === 0 ? '✓ 转码完成' : '✗ 转码结束，退出码 ' + code);
    emit('run:done', { code, out:o.out, ok: code === 0 });
  });
  return { started:true };
});

ipcMain.handle('run:cancel', () => {
  if (!child) return { ok:false };
  try { child.kill('SIGTERM'); child = null; } catch {}
  emit('log:line', '⚠ 已取消');
  return { ok:true };
});

ipcMain.handle('player:open', async (_e, dir) => {
  try {
    const url = await serveDir(dir);
    if (playerWin && !playerWin.isDestroyed()) { playerWin.loadURL(url); playerWin.focus(); }
    else {
      playerWin = new BrowserWindow({
        width: 1280, height: 800, backgroundColor: '#060509',
        title: 'ascii-full · 播放器',
        webPreferences: { contextIsolation:true, nodeIntegration:false },
      });
      playerWin.loadURL(url);
      playerWin.on('closed', () => { playerWin = null; });
    }
    return { ok:true, url };
  } catch (e) { return { ok:false, error:e.message }; }
});
