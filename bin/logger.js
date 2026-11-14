#!/usr/bin/env node
/*
 * logger.js —— 终端版共享日志：启动时打印环境/参数，过程写盘，结束给汇总
 *
 *   const log = createLogger({ name: 'ascii-full', dir: OUT });
 *   log.startup([['源片', 'a.mp4'], ['输出', OUT]]);
 *   log.info('开始解码');
 *   log.progress('帧 600 / 块 10');       // 只写文件，不刷屏
 *   log.summary(['帧数: 6300', '耗时: 42.1s']);
 *   log.close();
 *
 * 设计取舍：
 *  · 控制台保持人类可读（进度用 \r 覆盖，不能和逐行日志打架）
 *  · 文件里落完整时间线，方便 GUI 把日志流式显示、也方便事后排查
 *  · 日志写失败一律静默降级，绝不让日志把主流程搞崩
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const LEVELS = { DEBUG: 10, INFO: 20, STAGE: 20, WARN: 30, ERROR: 40 };

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function createLogger(opts = {}) {
  const name = opts.name || 'ascii-full';
  const quiet = !!opts.quiet;
  const minLevel = LEVELS[String(opts.level || 'DEBUG').toUpperCase()] || 0;
  const started = Date.now();

  // 日志文件默认落在产物目录；不可写就退到临时目录；再不行只打印。
  let file = opts.file ? path.resolve(String(opts.file)) : null;
  if (!file && opts.dir) {
    try {
      fs.mkdirSync(opts.dir, { recursive: true });
      file = path.join(opts.dir, `${name}.log`);
      fs.writeFileSync(file, '');
    } catch { file = null; }
  }
  if (file) {
    try { fs.appendFileSync(file, ''); }
    catch {
      try { file = path.join(os.tmpdir(), `${name}-${process.pid}.log`); fs.appendFileSync(file, ''); }
      catch { file = null; }
    }
  }

  function write(level, msg, toConsole = true) {
    if (LEVELS[level] < minLevel) return;
    const line = `[${stamp()}] [${level.padEnd(5)}] ${String(msg).replace(/\r/g, '').replace(/\x1b\[[0-9;]*m/g, '')}`;
    if (file) { try { fs.appendFileSync(file, line + '\n'); } catch {} }
    if (toConsole && !quiet) {
      const stream = level === 'ERROR' || level === 'WARN' ? process.stderr : process.stdout;
      stream.write(line + '\n');
    }
  }

  let lastProgress = 0;
  const api = {
    file,
    started,
    debug: m => write('DEBUG', m),
    info:  m => write('INFO', m),
    stage: m => write('STAGE', m),
    warn:  m => write('WARN', m),
    error: m => write('ERROR', m),
    // 进度只落盘、节流 1s，控制台留给 \r 动画
    progress(m) {
      const now = Date.now();
      if (now - lastProgress < 1000) return;
      lastProgress = now;
      if (file) {
        try { fs.appendFileSync(file, `[${stamp()}] [PROGR] ${String(m).replace(/\r/g, '')}\n`); } catch {}
      }
    },
    /** 启动信息块：一排键值 + 运行环境 */
    startup(rows = []) {
      const env = [
        ['版本', (() => {
          try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; }
          catch { return '?'; }
        })()],
        ['时间', stamp(new Date(started))],
        ['Node', process.version + ' / ' + process.platform + '-' + process.arch],
        ['日志', file || '（未落盘）'],
      ];
      const all = [...env, ...rows];
      const width = Math.max(...all.map(([k]) => String(k).length));
      for (const [k, v] of all) write('INFO', `${String(k).padEnd(width)} : ${v}`, false);
      if (!quiet) {
        for (const [k, v] of all) {
          process.stdout.write(`  ${String(k).padEnd(width)} : ${v}\n`);
        }
        process.stdout.write('\n');
      }
    },
    summary(rows = []) {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      for (const r of [...rows, `耗时 ${secs}s`]) write('INFO', r, false);
      // 汇总是一次性的最终输出，quiet 下也保留（quiet 只压掉过程日志）
      process.stdout.write('\n════ 汇总 ════\n');
      for (const r of [...rows, `耗时 ${secs}s`]) process.stdout.write('  ' + r + '\n');
    },
    close() {
      if (file) process.stdout.write(`  日志 : ${file}\n`);
    },
  };
  return api;
}

module.exports = { createLogger, stamp, LEVELS };

if (require.main === module) {
  const l = createLogger({ name: 'selftest', dir: process.argv[2] || os.tmpdir() });
  l.startup([['参数', '--selftest']]);
  l.info('hello');
  l.progress('帧 1');
  l.summary(['完成']);
  l.close();
}
