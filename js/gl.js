// film-lab · WebGL2 film pipeline
// Spatial constants are defined for a 2160-px short side and scale with resolution.
export const LOOK = {
  HAL_T: 0.20, HAL_SIG: 10.0, HAL_TINT: [1.0, 0.06, -0.47],
  BLOOM_T: 0.55, BLOOM_SIG: 54.0,
  VIG_P: 1.87,
  GRAIN_MONO: 0.86, GRAIN_CHROMA: 0.51, GRAIN_CH: [1.0, 0.92, 1.08],
  BORDER_RGB: [13 / 255, 15 / 255, 19 / 255],
};

const VS = `#version 300 es
in vec2 a; out vec2 v_uv;
void main(){ v_uv = a*0.5+0.5; gl_Position = vec4(a,0.,1.); }`;

const HEAD = `#version 300 es
precision highp float; precision highp sampler3D;
in vec2 v_uv; out vec4 o;
const vec3 W709 = vec3(0.2126,0.7152,0.0722);
vec3 dec(vec3 c){ return pow(clamp(c,0.,1.), vec3(2.4)); }
vec3 enc(vec3 c){ return pow(max(c,0.), vec3(1./2.4)); }
uniform vec4 u_srcRect;   // image-space (y-down) rect of the frame shown in this output
vec2 imgUV(){ return u_srcRect.xy + vec2(v_uv.x, 1.-v_uv.y)*u_srcRect.zw; }
`;

// pass 1: horizontal softness blur, sampling the source in source-pixel units
const FS_BLURH = HEAD + `
uniform sampler2D u_src; uniform float u_sig; uniform float u_srcW;
void main(){
  vec2 uv = imgUV();
  if (u_sig < 0.2) { o = vec4(texture(u_src, uv).rgb, 1.); return; }
  int r = int(ceil(u_sig*3.)); vec3 s = vec3(0.); float ws = 0.;
  for (int i=-9;i<=9;i++){ if (abs(i)>r) continue; float w = exp(-0.5*float(i*i)/(u_sig*u_sig));
    s += w*texture(u_src, uv + vec2(float(i)/u_srcW, 0.)).rgb; ws += w; }
  o = vec4(s/ws, 1.);
}`;

// pass 2: vertical softness blur + exposure + LUT
const FS_GRADE = HEAD + `
uniform sampler2D u_img; uniform sampler3D u_lut; uniform float u_sig, u_ev, u_strength; uniform vec2 u_outSize;
void main(){
  vec3 c;
  if (u_sig < 0.2) c = texture(u_img, v_uv).rgb;
  else { int r = int(ceil(u_sig*3.)); vec3 s = vec3(0.); float ws = 0.;
    for (int i=-9;i<=9;i++){ if (abs(i)>r) continue; float w = exp(-0.5*float(i*i)/(u_sig*u_sig));
      s += w*texture(u_img, v_uv + vec2(0., float(i)/u_outSize.y)).rgb; ws += w; }
    c = s/ws; }
  if (u_ev != 0.) c = clamp(enc(dec(c)*exp2(u_ev)), 0., 1.);
  vec3 g = texture(u_lut, c*(32./33.) + 0.5/33.).rgb;
  o = vec4(mix(c, g, u_strength), 1.);
}`;

// pass 3: 4x downsample, linear highlight extraction (R = halation source, G = bloom source)
const FS_HL = HEAD + `
uniform sampler2D u_img; uniform vec2 u_outSize; uniform float u_halT, u_bloomT;
void main(){
  vec2 px = 1./u_outSize; vec3 l = vec3(0.);
  l += dec(texture(u_img, v_uv + vec2(-1.,-1.)*px).rgb);
  l += dec(texture(u_img, v_uv + vec2( 1.,-1.)*px).rgb);
  l += dec(texture(u_img, v_uv + vec2(-1., 1.)*px).rgb);
  l += dec(texture(u_img, v_uv + vec2( 1., 1.)*px).rgb);
  float Y = dot(l*0.25, W709);
  o = vec4(max(Y-u_halT,0.), max(Y-u_bloomT,0.), 0., 1.);
}`;

// pass 4/5: separable gaussian on the small maps, separate sigma per channel
const FS_GLOW = HEAD + `
uniform sampler2D u_img; uniform vec2 u_dir; uniform vec2 u_sig; // (halation, bloom) in small px
void main(){
  vec2 s = vec2(0.), ws = vec2(0.); int r = int(ceil(max(u_sig.x,u_sig.y)*3.));
  vec2 isg = 1./max(u_sig*u_sig, vec2(1e-4));
  for (int i=-56;i<=56;i++){ if (abs(i)>r) continue; float fi=float(i);
    vec2 w = exp(-0.5*fi*fi*isg); vec2 t = texture(u_img, v_uv + u_dir*fi).rg; s += w*t; ws += w; }
  o = vec4(s/ws, 0., 1.);
}`;

// pass 6: vignette, halation, bloom, grain, border
const FS_FINAL = HEAD + `
uniform sampler2D u_img, u_glow, u_noise, u_border;
uniform vec2 u_frameSize; uniform float u_k;
uniform float u_vig, u_vigP, u_hal, u_halT, u_bloom, u_grain, u_gsize, u_borderOn;
uniform vec3 u_halTint, u_gch, u_borderRGB; uniform vec2 u_gmix;
uniform mat2 u_nrot; uniform vec2 u_noff;
float slice(float q, float D, float P){ const float C = 240.;
  if (q < C) return q; if (q > D - C) return P - (D - q); return C + (q - C)*(P - 2.*C)/max(D - 2.*C, 1.); }
vec2 borderUV(vec2 fuv){
  vec2 p = fuv*u_frameSize, D = u_frameSize;
  if (D.y > D.x) { p = p.yx; D = D.yx; }
  float s = D.y/2160.; vec2 q = p/s, Dq = D/s;
  return vec2(slice(q.x, Dq.x, 3840.), slice(q.y, Dq.y, 2160.)) / vec2(3840.,2160.);
}
void main(){
  vec2 fuv = imgUV(); vec2 fpx = fuv*u_frameSize;
  vec3 c = texture(u_img, v_uv).rgb;
  vec3 lin = dec(c); float Y = dot(lin, W709);
  float r = length(fpx - 0.5*u_frameSize)/length(0.5*u_frameSize);
  vec3 l = lin*max(1. - u_vig*pow(r, u_vigP), 0.);
  vec2 g = texture(u_glow, v_uv).rg;
  l += u_hal*max(g.r - max(Y - u_halT, 0.), 0.)*u_halTint;
  l += u_bloom*g.g;
  c = enc(l);
  if (u_grain > 0.) {
    float L = clamp(dot(c, W709), 0., 1.);
    float amp = u_grain*pow(clamp(4.*L*(1.-L), 0., 1.), 0.3);
    vec2 q = u_nrot*(fpx/(u_gsize*u_k)) + u_noff;
    vec4 n = (texture(u_noise, q/1024.) - 0.5)*8.;
    c += amp*(u_gmix.x*n.a + u_gmix.y*n.rgb)*u_gch;
  }
  if (u_borderOn > 0.5) { float a = texture(u_border, borderUV(fuv)).a; c = mix(c, u_borderRGB, a); }
  o = vec4(clamp(c, 0., 1.), 1.);
}`;

function toHalf(f) {
  const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, f); const x = b.getUint32(0);
  const s = (x >> 16) & 0x8000; let e = ((x >> 23) & 0xff) - 127 + 15; let m = x & 0x7fffff;
  if (e <= 0) return s; if (e >= 31) return s | 0x7c00;
  m = m + 0x1000; if (m & 0x800000) { m = 0; e++; }
  return s | (e << 10) | (m >> 13);
}

export function parseCube(text) {
  let n = 0; const vals = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim(); if (!t || t[0] === '#') continue;
    if (t.startsWith('LUT_3D_SIZE')) { n = parseInt(t.split(/\s+/)[1]); continue; }
    if (/^[A-Z_]/.test(t)) continue;
    const p = t.split(/\s+/).map(Number); if (p.length === 3 && p.every(Number.isFinite)) vals.push(p);
  }
  if (!n || vals.length !== n * n * n) throw new Error('Bad .cube file');
  return { n, vals };
}

// Tileable film-grain noise: two Gaussian-filtered octaves, unit variance, 4 independent channels.
export function makeNoise(N = 1024, seed = 1) {
  let s = seed >>> 0; const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = (arr) => { for (let i = 0; i < arr.length; i += 2) { const u = Math.max(rnd(), 1e-12), v = rnd(); const r = Math.sqrt(-2 * Math.log(u)); arr[i] = r * Math.cos(6.283185307 * v); arr[i + 1] = r * Math.sin(6.283185307 * v); } };
  const blur = (a, sig) => {
    const R = Math.ceil(sig * 3), k = []; let ks = 0; for (let i = -R; i <= R; i++) { const w = Math.exp(-0.5 * i * i / (sig * sig)); k.push(w); ks += w; } for (let i = 0; i < k.length; i++) k[i] /= ks;
    const t = new Float32Array(a.length), m = N - 1;
    for (let y = 0; y < N; y++) { const row = y * N; for (let x = 0; x < N; x++) { let acc = 0; for (let i = -R; i <= R; i++) acc += k[i + R] * a[row + ((x + i) & m)]; t[row + x] = acc; } }
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let acc = 0; for (let i = -R; i <= R; i++) acc += k[i + R] * t[(((y + i) & m) * N) + x]; a[y * N + x] = acc; }
  };
  const std = (a) => { let s1 = 0, s2 = 0; for (const v of a) { s1 += v; s2 += v * v; } const mu = s1 / a.length; return Math.sqrt(s2 / a.length - mu * mu); };
  const out = new Uint8Array(N * N * 4); const A = new Float32Array(N * N), B = new Float32Array(N * N);
  for (let c = 0; c < 4; c++) {
    gauss(A); gauss(B); blur(A, 0.6); blur(B, 1.8);
    const sa = std(A), sb = std(B); for (let i = 0; i < A.length; i++) A[i] = A[i] / sa + 0.8 * B[i] / sb;
    const s = std(A); for (let i = 0; i < A.length; i++) out[i * 4 + c] = Math.max(0, Math.min(255, Math.round((0.5 + A[i] / s / 8) * 255)));
  }
  return out;
}

export class FilmGL {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl; this.canvas = canvas; this.rt = {}; this.size = [0, 0]; this.frameNo = 0; this.useBitmap = false;
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.p = { blurh: this.prog(FS_BLURH), grade: this.prog(FS_GRADE), hl: this.prog(FS_HL), glow: this.prog(FS_GLOW), final: this.prog(FS_FINAL) };
    this.src = this.tex2D(); gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  }
  prog(fs) {
    const gl = this.gl; const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.bindAttribLocation(p, 0, 'a'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
    return { p, u };
  }
  tex2D(filter) { const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v); return t; }
  target(w, h) { const gl = this.gl, t = this.tex2D(); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return { t, f, w, h }; }
  load({ cubeText, borderImage, noise }) {
    const gl = this.gl;
    const { n, vals } = parseCube(cubeText); const h = new Uint16Array(n * n * n * 4);
    vals.forEach((v, i) => { h[i * 4] = toHalf(v[0]); h[i * 4 + 1] = toHalf(v[1]); h[i * 4 + 2] = toHalf(v[2]); h[i * 4 + 3] = 0x3c00; });
    this.lut = gl.createTexture(); gl.bindTexture(gl.TEXTURE_3D, this.lut);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, n, n, n, 0, gl.RGBA, gl.HALF_FLOAT, h);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
    this.noise = this.tex2D(gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1024, 1024, 0, gl.RGBA, gl.UNSIGNED_BYTE, noise); gl.generateMipmap(gl.TEXTURE_2D);
    this.border = this.tex2D(gl.LINEAR_MIPMAP_LINEAR);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, borderImage); gl.generateMipmap(gl.TEXTURE_2D);
  }
  ensure(w, h) {
    if (this.size[0] === w && this.size[1] === h) return;
    const gl = this.gl; for (const r of Object.values(this.rt)) { gl.deleteTexture(r.t); gl.deleteFramebuffer(r.f); }
    const sw = Math.max(1, Math.ceil(w / 4)), sh = Math.max(1, Math.ceil(h / 4));
    this.rt = { a: this.target(w, h), b: this.target(w, h), s1: this.target(sw, sh), s2: this.target(sw, sh) }; this.size = [w, h];
  }
  // Upload a frame. Returns false if this source type needs the ImageBitmap fallback.
  upload(source, mip) {
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
  }
  // frame: {w,h} frame size in px (processing orientation). view: {rect:[x,y,w,h] in image uv}
  render(frame, P, view = { rect: [0, 0, 1, 1] }, seed) {
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height; this.ensure(W, H);
    const rect = view.rect, k = Math.min(frame.w, frame.h) / 2160, pxScale = W / (frame.w * rect[2]);
    const use = (prog, fb, w, h) => { gl.useProgram(prog.p); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, w, h); gl.uniform4fv(prog.u.u_srcRect, rect); return prog.u; };
    const bind = (u, name, unit, tex, target = gl.TEXTURE_2D) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, tex); gl.uniform1i(u[name], unit); };
    gl.bindVertexArray(this.vao); gl.disable(gl.BLEND);
    const soft = P.soft * k;
    // 1
    let u = use(this.p.blurh, this.rt.a.f, W, H); bind(u, 'u_src', 0, this.src); gl.uniform1f(u.u_sig, Math.min(soft, 3)); gl.uniform1f(u.u_srcW, frame.w); gl.drawArrays(gl.TRIANGLES, 0, 3);
    // 2
    u = use(this.p.grade, this.rt.b.f, W, H); bind(u, 'u_img', 0, this.rt.a.t); bind(u, 'u_lut', 1, this.lut, gl.TEXTURE_3D);
    gl.uniform1f(u.u_sig, Math.min(soft * pxScale, 3)); gl.uniform1f(u.u_ev, P.ev); gl.uniform1f(u.u_strength, P.strength); gl.uniform2f(u.u_outSize, W, H); gl.drawArrays(gl.TRIANGLES, 0, 3);
    // 3
    const s1 = this.rt.s1, s2 = this.rt.s2;
    u = use(this.p.hl, s1.f, s1.w, s1.h); bind(u, 'u_img', 0, this.rt.b.t); gl.uniform2f(u.u_outSize, W, H); gl.uniform1f(u.u_halT, LOOK.HAL_T); gl.uniform1f(u.u_bloomT, LOOK.BLOOM_T); gl.drawArrays(gl.TRIANGLES, 0, 3);
    // 4,5
    const sig = [LOOK.HAL_SIG * k * pxScale / 4, LOOK.BLOOM_SIG * k * pxScale / 4].map(x => Math.min(x, 18));
    u = use(this.p.glow, s2.f, s2.w, s2.h); bind(u, 'u_img', 0, s1.t); gl.uniform2f(u.u_dir, 1 / s1.w, 0); gl.uniform2fv(u.u_sig, sig); gl.drawArrays(gl.TRIANGLES, 0, 3);
    u = use(this.p.glow, s1.f, s1.w, s1.h); bind(u, 'u_img', 0, s2.t); gl.uniform2f(u.u_dir, 0, 1 / s1.h); gl.uniform2fv(u.u_sig, sig); gl.drawArrays(gl.TRIANGLES, 0, 3);
    // 6
    u = use(this.p.final, null, W, H);
    bind(u, 'u_img', 0, this.rt.b.t); bind(u, 'u_glow', 1, s1.t); bind(u, 'u_noise', 2, this.noise); bind(u, 'u_border', 3, this.border);
    gl.uniform2f(u.u_frameSize, frame.w, frame.h); gl.uniform1f(u.u_k, k);
    gl.uniform1f(u.u_vig, P.vig); gl.uniform1f(u.u_vigP, LOOK.VIG_P); gl.uniform1f(u.u_hal, P.hal); gl.uniform1f(u.u_halT, LOOK.HAL_T); gl.uniform3fv(u.u_halTint, LOOK.HAL_TINT);
    gl.uniform1f(u.u_bloom, P.bloom); gl.uniform1f(u.u_grain, P.grain); gl.uniform1f(u.u_gsize, P.gsize); gl.uniform1f(u.u_borderOn, P.border ? 1 : 0);
    gl.uniform3fv(u.u_gch, LOOK.GRAIN_CH); gl.uniform2f(u.u_gmix, LOOK.GRAIN_MONO, LOOK.GRAIN_CHROMA); gl.uniform3fv(u.u_borderRGB, LOOK.BORDER_RGB);
    // per-frame grain placement: random offset + one of 8 rotations/flips
    let st = (seed ?? this.frameNo++) * 2654435761 >>> 0; const rnd = () => { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296; };
    const rot = Math.floor(rnd() * 4), flip = rnd() < 0.5 ? -1 : 1; const cs = [[1, 0], [0, 1], [-1, 0], [0, -1]][rot];
    gl.uniformMatrix2fv(u.u_nrot, false, [cs[0] * flip, cs[1], -cs[1] * flip, cs[0]]); gl.uniform2f(u.u_noff, rnd() * 1024, rnd() * 1024);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
