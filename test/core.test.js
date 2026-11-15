#!/usr/bin/env node
/* v1.5 渲染核心的纯逻辑断言：不依赖浏览器 / DOM / ffmpeg。
 * 由 test/smoke.js 以 check(ok) 形式调用，CI 与本地 npm test 都会跑到。 */
'use strict';
const path = require('path');
const core = require(path.join(__dirname, '..', 'web', '_render-core.js'));

function check(ok) {
  ok(core.VERSION === '1.5.0', 'render core 版本 1.5.0');

  // ---- 色域协商 ----
  const p3Screen = { p3: true, cssColor: true, canvasP3: true };
  const srgbScreen = { p3: false, cssColor: false, canvasP3: false };

  let a = core.gamutPlan(null, srgbScreen);
  ok(a.mode === 'srgb' && !a.convert && !a.canvasP3, '老产物无 meta.color → sRGB / identity');
  a = core.gamutPlan({ color: { gamut: 'srgb', source: 'probe' } }, p3Screen);
  ok(a.mode === 'srgb' && !a.convert, 'BT.709 素材即使 P3 屏也不硬升');

  a = core.gamutPlan({ color: { gamut: 'p3', source: 'probe' } }, p3Screen);
  ok(a.mode === 'p3' && a.canvasP3 && !a.convert, '真 P3 数据 + P3 屏 → 按 P3 呈现');
  a = core.gamutPlan({ color: { gamut: 'p3', source: 'probe' } }, srgbScreen);
  ok(a.mode === 'p3-to-srgb' && a.convert && !a.canvasP3, '真 P3 数据 + sRGB 屏 → 线性矩阵降级');
  a = core.gamutPlan({ color: { gamut: 'p3', source: 'expand' } }, p3Screen);
  ok(a.mode === 'p3' && a.canvasP3, 'expand + P3 屏 → 按 P3 解释（有意扩色域）');
  a = core.gamutPlan({ color: { gamut: 'p3', source: 'expand' } }, srgbScreen);
  ok(a.mode === 'p3-expand-fallback' && !a.convert, 'expand + sRGB 屏 → 原样降级，不二次染色');

  // ---- 线性光矩阵 ----
  const out = [0, 0, 0];
  core.convertColor(10, 20, 30, { convert: false }, out);
  ok(out[0] === 10 && out[1] === 20 && out[2] === 30, 'identity 转换逐字节不变');
  const p3 = core.gamutPlan({ color: { gamut: 'p3', source: 'probe' } }, srgbScreen);
  core.convertColor(128, 128, 128, p3, out);
  ok(Math.abs(out[0] - 128) <= 1 && Math.abs(out[1] - 128) <= 1 && Math.abs(out[2] - 128) <= 1,
    '灰度经 P3→sRGB 矩阵后仍为中性灰（行和≈1）');
  core.convertColor(255, 0, 0, p3, out);
  // P3 纯红在 sRGB 色域之外：矩阵会把 G/B 压成负值，clamp 到 0 是预期行为，
  // 不是 bug。这里验证「裁到边界且无溢出」，而不是要求三通道都 >0。
  ok(out[0] >= 250 && out.every(v => v >= 0 && v <= 255),
    '饱和 P3 红压缩回 sRGB 后落在 [0,255]，超出部分裁边而非溢出');
  for (const v of out) ok(v >= 0 && v <= 255 && Number.isInteger(v), '转换结果始终是 8bit 整数');

  // ---- ramp 旁路 ----
  let r = core.resolveRamp({ ramp: ' .:-=+*#%@' });
  ok(r.chars.length === 10 && !r.useAtlas && r.count === 10, '老产物字符串 ramp 正常解析');
  r = core.resolveRamp({});
  ok(r.chars === core.DEFAULT_RAMP && r.count === 70, '无 ramp 字段 → 内置 70 级');
  r = core.resolveRamp({
    ramp: ' ab', count: 3,
    rampSpec: { version: 2, count: 3, file: 'ramp.json', atlas: { file: 'ramp-atlas.png', cols: 2, rows: 2, count: 3 } }
  });
  ok(r.useAtlas && r.count === 3 && r.spec.atlas.file === 'ramp-atlas.png', '自定义 rampSpec 走图集路径');

  // ---- WebGL 字形渲染器 ----
  ok(typeof core.GlyphGL === 'function', 'GlyphGL 构造器可用');
  ok(core.VERT.includes('vUv') && core.FRAG.includes('uAtlas'), '顶点 / 片元着色器含纹理采样');
  ok(core.FRAG.includes('uIdx') && core.FRAG.includes('uRgb') && core.FRAG.includes('uGrid'),
    'shader 用「索引 + RGB + 图集」三纹理，一次 draw call');
  ok(typeof core.GlyphGL.prototype.setOutputColorSpace === 'function', '有 display-p3 输出协商');
  ok(core.P3_TO_SRGB.length === 9 && core.IDENTITY.length === 9, '色域矩阵为 3×3');

  // ---- 一次 draw call 的实测（mock GL，不需要浏览器） ----
  (function () {
    const calls = { draw: 0, texImage: 0 };
    const gl = {
      VERTEX_SHADER:1, FRAGMENT_SHADER:2, COMPILE_STATUS:3, LINK_STATUS:4,
      ARRAY_BUFFER:5, STATIC_DRAW:6, FLOAT:7, TEXTURE_2D:8, TEXTURE0:100,
      TEXTURE_MIN_FILTER:9, TEXTURE_MAG_FILTER:10, NEAREST:11,
      TEXTURE_WRAP_S:12, TEXTURE_WRAP_T:13, CLAMP_TO_EDGE:14,
      UNPACK_FLIP_Y_WEBGL:15, UNPACK_PREMULTIPLY_ALPHA_WEBGL:16,
      RGBA:17, UNSIGNED_BYTE:18, LUMINANCE:19, RGB:20, TRIANGLE_STRIP:21,
      drawingBufferColorSpace:'srgb',
      createShader:()=>({}), shaderSource(){}, compileShader(){},
      getShaderParameter:()=>true, deleteShader(){},
      createProgram:()=>({}), attachShader(){}, linkProgram(){},
      getProgramParameter:()=>true, getProgramInfoLog:()=>'', useProgram(){},
      createBuffer:()=>({}), bindBuffer(){}, bufferData(){},
      getAttribLocation:()=>0, enableVertexAttribArray(){}, vertexAttribPointer(){},
      getUniformLocation:(_p,n)=>n,
      createTexture:()=>({}), activeTexture(){}, bindTexture(){}, texParameteri(){},
      pixelStorei(){}, texImage2D(){ calls.texImage++; },
      uniform1i(){}, uniform2f(){}, uniform1f(){}, viewport(){},
      drawArrays(){ calls.draw++; },
    };
    const canvas = { getContext:()=>gl, width:0, height:0 };
    const g = new core.GlyphGL(canvas);
    ok(g.init({}, { cols:8, rows:4, count:32 }) === true && g.ok,
      'GlyphGL 在 mock WebGL 上初始化成功');
    g.resize(9, 5, 72, 80);
    const n = 45, u8 = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      u8[i*4] = i % 32; u8[i*4+1] = 100; u8[i*4+2] = 150; u8[i*4+3] = 200;
    }
    const lut = new Uint8Array(256); for (let i = 0; i < 256; i++) lut[i] = i;
    ok(g.draw(u8, 0, 4, lut, { convert:false }) === true && calls.draw === 1,
      '整帧只调用 1 次 drawArrays（不是 5 万次 fillText）');
    ok(calls.texImage === 3,
      '共 3 次纹理上传：init 时图集 1 次 + 每帧索引/RGB 2 次');
    ok(g.setOutputColorSpace({ canvasP3:true }) === true &&
       gl.drawingBufferColorSpace === 'display-p3', 'P3 屏设 drawingBufferColorSpace');
    ok(g.setOutputColorSpace({ canvasP3:false }) === true &&
       gl.drawingBufferColorSpace === 'srgb', 'sRGB 屏回到 srgb');
  })();
}

module.exports = { check };
