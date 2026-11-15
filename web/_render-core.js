/* ascii-full render core v1.5.0
 *
 * 由 scripts/inline-core.js 内联进 player.html 与 standalone.html，
 * 保证「四张脸同一副骨架」：两个播放器永远拿到逐字相同的渲染逻辑。
 *
 * 三件事：
 *   1. 色域协商 —— 数据声明 P3 时，支持 P3 的屏按 P3 呈现，只支持 sRGB 的屏
 *      做一次线性光矩阵降级；老产物 / BT.709 素材走 identity，零开销零回归。
 *   2. ramp 解析 —— 自定义字形表作为产物目录里的旁路文件，不进 chunks。
 *   3. GlyphGL —— 把 70~200 级字形预烘焙成图集纹理，每帧只上传「索引 + RGB」
 *      两张小纹理，一次 draw call 画完整帧，绕开 5 万次 fillText。
 */
(function (global) {
'use strict';

var IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// Display P3 (D65) → sRGB，线性光域的 3×3 矩阵（列主序按行写，逐行乘）。
// 用于「真实 P3 数据落到 sRGB 屏」时的色域压缩，不是简单丢弃标签。
var P3_TO_SRGB = [
   1.2249401, -0.2249401,  0.0000000,
  -0.0420569,  1.0420569,  0.0000000,
  -0.0196376, -0.0786360,  1.0982736
];

var DEC = new Float32Array(256);       // 8bit gamma → 线性光
for (var i = 0; i < 256; i++) {
  var v = i / 255;
  DEC[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function enc(v) {
  v = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}
var clamp255 = function (v) { return v < 0 ? 0 : v > 255 ? 255 : v; };

/** 浏览器/屏幕能力探测。失败一律按 sRGB 处理，绝不因探测异常白屏。 */
function detectColorSupport() {
  var media = false, cssColor = false, canvasP3 = false;
  try {
    media = !!(global.matchMedia && global.matchMedia('(color-gamut: p3)').matches);
  } catch (_) {}
  try {
    cssColor = !!(global.CSS && global.CSS.supports &&
      (global.CSS.supports('color', 'color(display-p3 1 0 0)') ||
       global.CSS.supports('color: color(display-p3 1 0 0)')));
  } catch (_) {}
  try {
    var c = document.createElement('canvas'); c.width = c.height = 1;
    canvasP3 = !!c.getContext('2d', { colorSpace: 'display-p3' });
  } catch (_) {}
  return { p3: media && (cssColor || canvasP3), cssColor: cssColor, canvasP3: canvasP3 };
}

/**
 * 决定这一帧怎么解释那 3 个颜色字节。
 *  - srgb / 老产物 / 无声明      → identity
 *  - 真 P3 数据 + P3 屏          → 按 P3 呈现（canvas colorSpace:'display-p3'）
 *  - 真 P3 数据 + sRGB 屏        → 线性矩阵压缩到 sRGB
 *  - expand（数值仍是 sRGB，只是请求按 P3 呈现）
 *      · P3 屏   → 按 P3 解释，饱和度提升（实验性，明确是有意扩色域）
 *      · sRGB 屏 → identity，原样降级，不二次染色
 */
function gamutPlan(meta, support) {
  var c = (meta && meta.color) || null;
  var declared = c && c.gamut === 'p3' ? 'p3' : 'srgb';
  var expanded = !!(c && c.source === 'expand');
  if (declared === 'p3' && support && support.p3) {
    return { mode: 'p3', matrix: IDENTITY, convert: false, canvasP3: true, declared: declared };
  }
  if (declared === 'p3' && !expanded) {
    return { mode: 'p3-to-srgb', matrix: P3_TO_SRGB, convert: true, canvasP3: false, declared: declared };
  }
  if (declared === 'p3' && expanded) {
    return { mode: 'p3-expand-fallback', matrix: IDENTITY, convert: false, canvasP3: false, declared: declared };
  }
  return { mode: 'srgb', matrix: IDENTITY, convert: false, canvasP3: false, declared: 'srgb' };
}

/** 把已过亮度 LUT 的 r,g,b 按 plan 转换。identity 时直接回写，不分配数组。 */
function convertColor(r, g, b, plan, out) {
  out[0] = r; out[1] = g; out[2] = b;
  if (!plan || !plan.convert) return out;
  var m = plan.matrix, R = DEC[r], G = DEC[g], B = DEC[b];
  out[0] = clamp255(enc(m[0] * R + m[1] * G + m[2] * B));
  out[1] = clamp255(enc(m[3] * R + m[4] * G + m[5] * B));
  out[2] = clamp255(enc(m[6] * R + m[7] * G + m[8] * B));
  return out;
}

/** ramp 旁路：老产物 meta.ramp 是纯字符串，新产物多一段 rampSpec。 */
var DEFAULT_RAMP = " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";
function resolveRamp(meta) {
  var chars = (meta && typeof meta.ramp === 'string' && meta.ramp.length) ? meta.ramp : DEFAULT_RAMP;
  var spec = (meta && meta.rampSpec && meta.rampSpec.atlas && meta.rampSpec.atlas.file) ? meta.rampSpec : null;
  return { chars: chars, spec: spec, count: chars.length, useAtlas: !!spec };
}

var VERT = [
  'attribute vec2 aPos;',
  'varying vec2 vUv;',
  'void main(){',
  '  vUv = vec2((aPos.x + 1.0) * 0.5, 1.0 - (aPos.y + 1.0) * 0.5);',
  '  gl_Position = vec4(aPos, 0.0, 1.0);',
  '}'
].join('\n');

// uAtlas 是预烘焙字形图集：每级一个 tile，alpha = 该像素的墨量。
// 索引纹理存 0..N-1（LUMINANCE 归一化后 *255 还原），颜色纹理存已转换的 RGB。
var FRAG = [
  'precision highp float;',
  'uniform sampler2D uIdx, uRgb, uAtlas;',
  'uniform vec2 uGrid;',        // W, H
  'uniform vec2 uAtlasCols;',   // cols, rows
  'uniform float uLevels;',
  'varying vec2 vUv;',
  'void main(){',
  '  vec2 cell = floor(vec2(vUv.x, 1.0 - vUv.y) * uGrid);',
  '  vec2 uv = (cell + 0.5) / uGrid;',
  '  uv.y = 1.0 - uv.y;',
  '  float idx = floor(texture2D(uIdx, uv).r * 255.0 + 0.5);',
  '  vec3 col = texture2D(uRgb, uv).rgb;',
  '  vec2 local = fract(vec2(vUv.x, 1.0 - vUv.y) * uGrid);',
  '  float k = mod(idx, uAtlasCols.x);',
  '  float row = floor(idx / uAtlasCols.x);',
  '  vec2 tile = vec2(1.0 / uAtlasCols.x, 1.0 / uAtlasCols.y);',
  '  vec2 auv = (vec2(k, row) + vec2(local.x, 1.0 - local.y)) * tile;',
  '  float cov = texture2D(uAtlas, auv).a;',
  '  gl_FragColor = vec4(col * cov, 1.0);',
  '}'
].join('\n');

function compile(gl, type, src) {
  var s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    var e = gl.getShaderInfoLog(s); gl.deleteShader(s);
    throw new Error('shader: ' + e);
  }
  return s;
}

/**
 * 一次 draw call 的字形渲染器。
 * 只在 plain（colors===1）且 rampSpec.atlas 存在且 WebGL 可用时启用；
 * half / 无图集 / 无 WebGL 一律回退 2D 路径，绝不白屏。
 */
function GlyphGL(canvas) {
  this.canvas = canvas;
  this.gl = null;
  this.ok = false;
  this.atlasSpec = null;
  this.W = 0; this.H = 0;
}
GlyphGL.prototype.init = function (atlasImage, atlasSpec) {
  var gl = this.canvas.getContext('webgl', {
    alpha: false, antialias: false, depth: false,
    preserveDrawingBuffer: true, premultipliedAlpha: false
  }) || this.canvas.getContext('experimental-webgl');
  if (!gl) return false;
  this.gl = gl;
  var prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  this.prog = prog;

  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  this.u = {
    idx: gl.getUniformLocation(prog, 'uIdx'),
    rgb: gl.getUniformLocation(prog, 'uRgb'),
    atlas: gl.getUniformLocation(prog, 'uAtlas'),
    grid: gl.getUniformLocation(prog, 'uGrid'),
    cols: gl.getUniformLocation(prog, 'uAtlasCols'),
    levels: gl.getUniformLocation(prog, 'uLevels')
  };

  function mkTex(unit) {
    var t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  this.tIdx = mkTex(0); this.tRgb = mkTex(1); this.tAtlas = mkTex(2);

  gl.activeTexture(gl.TEXTURE0 + 2);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasImage);
  gl.uniform1i(this.u.idx, 0); gl.uniform1i(this.u.rgb, 1); gl.uniform1i(this.u.atlas, 2);

  this.atlasSpec = atlasSpec;
  gl.uniform2f(this.u.cols, atlasSpec.cols, atlasSpec.rows);
  gl.uniform1f(this.u.levels, atlasSpec.count);
  this.ok = true;
  return true;
};
/** 支持时把 WebGL drawing buffer 声明成 display-p3；老浏览器静默忽略。 */
GlyphGL.prototype.setOutputColorSpace = function (plan) {
  var gl = this.gl;
  if (!gl) return false;
  try {
    gl.drawingBufferColorSpace = plan && plan.canvasP3 ? 'display-p3' : 'srgb';
    return gl.drawingBufferColorSpace === (plan && plan.canvasP3 ? 'display-p3' : 'srgb');
  } catch (_) { return false; }
};
GlyphGL.prototype.resize = function (W, H, pxW, pxH) {
  this.W = W; this.H = H;
  this.canvas.width = pxW; this.canvas.height = pxH;
  if (this.gl) this.gl.viewport(0, 0, pxW, pxH);
};
GlyphGL.prototype.draw = function (u8, base, bpc, gainLut, plan) {
  var gl = this.gl, W = this.W, H = this.H, n = W * H;
  if (!gl || n <= 0) return false;
  var idx = new Uint8Array(n), rgb = new Uint8Array(n * 3), tmp = [0, 0, 0];
  for (var i = 0; i < n; i++) {
    var o = base + i * bpc;
    idx[i] = u8[o];
    convertColor(gainLut[u8[o+1]], gainLut[u8[o+2]], gainLut[u8[o+3]], plan, tmp);
    rgb[i*3] = tmp[0]; rgb[i*3+1] = tmp[1]; rgb[i*3+2] = tmp[2];
  }
  gl.activeTexture(gl.TEXTURE0 + 0);
  gl.bindTexture(gl.TEXTURE_2D, this.tIdx);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, W, H, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, idx);
  gl.activeTexture(gl.TEXTURE0 + 1);
  gl.bindTexture(gl.TEXTURE_2D, this.tRgb);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, W, H, 0, gl.RGB, gl.UNSIGNED_BYTE, rgb);
  gl.uniform2f(this.u.grid, W, H);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return true;
};

var API = {
  IDENTITY: IDENTITY, P3_TO_SRGB: P3_TO_SRGB,
  detectColorSupport: detectColorSupport, gamutPlan: gamutPlan,
  convertColor: convertColor, resolveRamp: resolveRamp,
  DEFAULT_RAMP: DEFAULT_RAMP, GlyphGL: GlyphGL,
  VERT: VERT, FRAG: FRAG, VERSION: '1.5.0'
};
global.AsciiFullCore = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
