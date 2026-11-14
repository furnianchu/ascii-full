'use strict';
const $ = s => document.querySelector(s);
const logEl = $('#log');
let running = false, lastOut = '', totalFrames = 0;

function append(line) {
  const span = document.createElement('span');
  if (/^✗|error|失败/i.test(line)) span.className = 'err';
  else if (/^✓|完成|listening/i.test(line)) span.className = 'ok';
  span.textContent = line.replace(/\x1b\[[0-9;]*m/g, '') + '\n';
  logEl.appendChild(span);
  // 只保留最近 1200 行，长任务不拖慢界面
  while (logEl.childNodes.length > 1200) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;

  const est = /预计\s+(\d+)\s+帧/.exec(line);
  if (est) totalFrames = +est[1];
  const cur = /帧\s+(\d+)/.exec(line);
  if (cur && totalFrames) {
    const pct = Math.min(100, Math.round(+cur[1] / totalFrames * 100));
    $('#bar').style.width = pct + '%';
    $('#status').textContent = `转码中… ${pct}%（${cur[1]} / ${totalFrames} 帧）`;
  }
}

function setRunning(on) {
  running = on;
  $('#start').disabled = on;
  $('#cancel').disabled = !on;
  $('#open').disabled = on || !lastOut;
}

function collect() {
  const src = $('#src').value.trim(), out = $('#out').value.trim();
  if (!src) { alert('先选源视频'); return null; }
  if (!out) { alert('先选输出目录'); return null; }
  return {
    src, out,
    grid: $('#grid').value || 60,
    fps: $('#fps').value.trim(),
    chunk: $('#chunk').value || 60,
    ramp: $('#ramp').value,
    from: $('#from').value.trim(),
    to: $('#to').value.trim(),
    half: $('#half').checked,
    force: $('#force').checked,
    logo: $('#logo').value.trim() || 'ASCII FULL',
    logoChar: $('#logoChar').value || '#',
    noLogo: $('#noLogo').checked,
  };
}

$('#pickSrc').onclick = async () => { const p = await af.pickVideo(); if (p) $('#src').value = p; };
$('#pickOut').onclick = async () => {
  const p = await af.pickDir();
  if (p) $('#out').value = p;
};
$('#clear').onclick = () => { logEl.textContent = ''; };

$('#start').onclick = async () => {
  const o = collect(); if (!o) return;
  logEl.textContent = ''; totalFrames = 0;
  $('#bar').style.width = '0%';
  const r = await af.start(o);
  if (!r.started) { append('✗ ' + (r.error || '没能启动')); return; }
  lastOut = o.out;
  setRunning(true);
  $('#status').textContent = '转码中… 正在探测源片';
};

$('#cancel').onclick = async () => { await af.cancel(); setRunning(false); $('#status').textContent = '已取消'; };
$('#open').onclick = async () => {
  if (!lastOut) return;
  const r = await af.openPlayer(lastOut);
  if (!r.ok) append('✗ 打开播放器失败: ' + r.error);
  else append('✓ 播放器窗口已打开');
};
$('#export').onclick = async () => {
  const r = await af.saveStandalone();
  if (r.ok) append('✓ 已导出独立播放器: ' + r.path);
  else if (!r.canceled) append('✗ 导出失败: ' + r.error);
};

af.onLog(append);
af.onDone(r => {
  setRunning(false);
  $('#bar').style.width = r.ok ? '100%' : '0%';
  $('#status').textContent = r.ok ? '完成 ✓ 可以点「打开播放器」了' : '失败 ✗ 看右边日志';
  if (r.ok) append('✓ 产物目录: ' + r.out);
});

af.info().then(i => {
  $('#env').innerHTML =
    `v${i.version} · Electron ${i.electron}<br>` +
    `${i.platform} · ffmpeg 内置 ${i.hasCli ? '✓' : '✗ 缺 CLI'}<br>` +
    `<span title="${i.ffmpeg}">${i.hasPlayer ? '播放器资源 ✓' : '⚠ 缺播放器资源'}</span>`;
  if (!i.hasCli) append('✗ 找不到转码器脚本：' + i.cli);
});
