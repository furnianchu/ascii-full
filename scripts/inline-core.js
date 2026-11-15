#!/usr/bin/env node
/* 把 web/_render-core.js 内联进两个单文件播放器。
 * standalone 必须自包含（零安装、双击即用），player.html 也必须自包含
 * （转码时只 cp 一个文件到产物目录），所以不能改成 <script src>。
 * 用同一个源内联，才能避免「CLI 改了、GUI / 单文件漏同步」的老问题。
 *
 *   node scripts/inline-core.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const core = fs.readFileSync(path.join(ROOT, 'web', '_render-core.js'), 'utf8');
const hash = crypto.createHash('sha256').update(core).digest('hex').slice(0, 12);
const banner = `/* ascii-full render core ${hash} — 由 scripts/inline-core.js 生成，勿手改本段 */\n`;
const targets = ['player.html', 'standalone.html'];
const re = /(<script id="render-core">)[\s\S]*?(<\/script>)/;

for (const name of targets) {
  const p = path.join(ROOT, 'web', name);
  const src = fs.readFileSync(p, 'utf8');
  if (!re.test(src)) {
    console.error('✗ ' + name + ' 缺少 <script id="render-core"> 占位');
    process.exit(1);
  }
  const out = src.replace(re, (_m, a, b) => a + '\n' + banner + core + b);
  fs.writeFileSync(p, out);
  console.log('✓ ' + name + '  内联 core ' + hash + '  (' + core.split('\n').length + ' 行)');
}
console.log('两个播放器现在共享逐字相同的渲染核心。');
