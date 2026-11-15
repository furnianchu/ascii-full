/*
 * 渲染等价性测试：直接从 web/player.html 抽出真实渲染代码，在 vm 里用 mock canvas
 * 验证「优化后的分组 / ImageData 路径」与「逐 cell 绘制」逐像素等价。
 * 不需要 ffmpeg，也不需要浏览器。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const CORE = require(path.join(ROOT, 'web', '_render-core.js'));

function mockCtx() {
  const ops = []; let style = '';
  return {
    ops,
    set fillStyle(v) { style = v; }, get fillStyle() { return style; },
    fillRect(x, y, w, h) { ops.push({ t:'rect', x, y, w, h, c:style }); },
    fillText(g, x, y) { ops.push({ t:'text', g, x, y, c:style }); },
    drawImage() {}, setTransform() {}, clearRect() {},
    set font(v) {}, set textBaseline(v) {}, set imageSmoothingEnabled(v) {},
    createImageData(w, h) { return { width:w, height:h, data:new Uint8ClampedArray(w*h*4) }; },
    putImageData(img) { this.lastImage = img; },
  };
}

function loadRenderer() {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'player.html'), 'utf8');
  const m = /<script>\n([\s\S]*?)\n<\/script>/.exec(html);
  if (!m) throw new Error('player.html 里找不到 <script>');
  const a = m[1].indexOf('const GAIN_LUT');
  const b = m[1].indexOf('function tick(');
  if (a < 0 || b < 0) throw new Error('player.html 渲染块结构变了');
  return m[1].slice(a, b) + '\n;globalThis.__api={draw,drawBlocks,drawText,buildGainLut,GAIN_LUT};';
}

function run(code, meta, u8, blockMode, gain) {
  const ctx = mockCtx(), off = mockCtx();
  const sandbox = {
    M:meta, CELL_W:8, CELL_H:16, gain, blockMode, chase:false, MAX_CACHE:6,
    // draw() 的状态栏会读音频状态；渲染等价性测试里按「无音轨」情形 mock
    masterEl:null, AUD:[], muted:false, offsetSec:0,
    ctx, cv:{ width:meta.W*8, height:meta.H*16, hidden:false },
    // v1.5：本测试专测 2D 逐像素等价性，显式关掉 WebGL 分支。
    // 图集采样与色域协商由 test/core.test.js 单独断言。
    CORE, gamut: CORE.gamutPlan(null, { p3:false, cssColor:false, canvasP3:false }),
    RGB:[0,0,0], rampInfo:null, glReady:false, glyphGL:null, glForcedOff:true, glNote:'',
    glCv:{ hidden:true }, colorSupport:{ p3:false, cssColor:false, canvasP3:false },
    cache:new Map([[0, u8]]), offCv:null, offCtx:null, offImg:null,
    performance:{ now:()=>1000 },
    document:{ createElement:() => ({ width:0, height:0, getContext:()=>off }) },
    $:()=>({ value:'', textContent:'', classList:{ toggle(){} } }),
    ensureChunk:()=>Promise.resolve(), fail:()=>{}, requestAnimationFrame:()=>0,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  sandbox.__api.draw(0);
  return { ctx, off, GAIN_LUT:sandbox.__api.GAIN_LUT };
}

function check(ok) {
  const code = loadRenderer();
  const RAMP = ' .:-=+*#%@';
  for (const half of [false, true]) {
    const W = 9, H = 5, bpc = half ? 7 : 4;
    const meta = { W, H, half, ramp:RAMP, bytesPerCell:bpc, frameBytes:W*H*bpc,
                   chunkFrames:60, fps:24, frames:1, chunks:1 };
    const u8 = new Uint8Array(W*H*bpc);
    for (let i = 0; i < W*H; i++) {
      const o = i*bpc, base = (i%7)*36;
      u8[o] = (i%4 === 0) ? 0 : (i%RAMP.length);     // 含空格
      u8[o+1] = base; u8[o+2] = 255-base; u8[o+3] = (i*13)%256;
      if (half) { u8[o+4] = 255-base; u8[o+5] = base; u8[o+6] = (i*29)%256; }
    }
    for (const gain of [1, 1.7]) {
      const tag = `half=${half} gain=${gain}`;
      // 色块 → ImageData 逐像素
      const r = run(code, meta, u8, true, gain);
      ok(!!r.off.lastImage, tag+' 色块: 走 ImageData 路径');
      if (r.off.lastImage) {
        const d = r.off.lastImage.data, row = W*4;
        ok(d.length === W*(half?H*2:H)*4, tag+' 色块: 画布尺寸');
        let bad = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const o = (y*W+x)*bpc, i = ((half?2*y:y)*W+x)*4;
          const e = [r.GAIN_LUT[u8[o+1]], r.GAIN_LUT[u8[o+2]], r.GAIN_LUT[u8[o+3]], 255];
          for (let c = 0; c < 4; c++) if (d[i+c] !== e[c]) bad++;
          if (half) {
            const q = i+row;
            const e2 = [r.GAIN_LUT[u8[o+4]], r.GAIN_LUT[u8[o+5]], r.GAIN_LUT[u8[o+6]], 255];
            for (let c = 0; c < 4; c++) if (d[q+c] !== e2[c]) bad++;
          }
        }
        ok(bad === 0, tag+` 色块: 逐像素一致 (diff=${bad})`);
      }
      // 字符 → 分组后每 cell 的 glyph/颜色
      const t = run(code, meta, u8, false, gain);
      const texts = t.ctx.ops.filter(o => o.t === 'text');
      const at = new Map();
      for (const o of texts) at.set(Math.round(o.x/8)+','+Math.round((o.y+16*.04)/16), o);
      let miss = 0, wrong = 0, extra = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y*W+x)*bpc, got = at.get(x+','+y);
        if (RAMP[u8[o]] === ' ') { if (got) extra++; continue; }
        if (!got) { miss++; continue; }
        const e = 'rgb('+t.GAIN_LUT[u8[o+1]]+','+t.GAIN_LUT[u8[o+2]]+','+t.GAIN_LUT[u8[o+3]]+')';
        if (got.c !== e || got.g !== (half ? '▀' : RAMP[u8[o]])) wrong++;
      }
      ok(miss === 0 && wrong === 0 && extra === 0,
         tag+` 字符: 空格跳过/颜色字形一致 (miss=${miss},wrong=${wrong},extra=${extra})`);
      ok(new Set(texts.map(o => o.c)).size < W*H, tag+' 字符: 颜色分组确实减少了 fillStyle');
    }
  }
}
module.exports = { check };
