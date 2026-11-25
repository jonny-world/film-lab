// film-lab v2 · WebGL2 film pipeline
// Order (per frame): softness → colour controls → [halation + bloom from a highlight pyramid] → grain in exposure
// (density) space → film-stock LUT → vignette → film gate. Spatial sizes are defined for a 2160-px short side.
export const LOOK = {
  HAL_T: 0.20, BLOOM_T: 0.50,
  HAL_NEAR: [1.0, 0.15, 0.04], HAL_FAR: [0.45, 0.14, 0.01], BLOOM_TINT: [1.0, 0.93, 0.84],
  VIG_P: 1.87, BORDER_RGB: [13 / 255, 15 / 255, 19 / 255],
};

const VS = `#version 300 es
in vec2 a; out vec2 v_uv;
void main(){ v_uv = a*0.5+0.5; gl_Position = vec4(a,0.,1.); }`;

const HEAD = `#version 300 es
precision highp float; precision highp int; precision highp sampler3D;
in vec2 v_uv; out vec4 o;
const vec3 W709 = vec3(0.2126,0.7152,0.0722);
vec3 dec(vec3 c){ return pow(clamp(c,0.,1.), vec3(2.4)); }
vec3 enc(vec3 c){ return pow(max(c,0.), vec3(1./2.4)); }
uniform vec4 u_srcRect;
vec2 imgUV(){ return u_srcRect.xy + vec2(v_uv.x, 1.-v_uv.y)*u_srcRect.zw; }
`;

const FS_SOFTH = HEAD + `
uniform sampler2D u_src; uniform float u_sig; uniform float u_srcW;
void main(){
  vec2 uv = imgUV();
  if (u_sig < 0.2) { o = vec4(texture(u_src, uv).rgb, 1.); return; }
  int r = int(ceil(u_sig*3.)); vec3 s = vec3(0.); float ws = 0.;
  for (int i=-9;i<=9;i++){ if (abs(i)>r) continue; float w = exp(-0.5*float(i*i)/(u_sig*u_sig));
    s += w*texture(u_src, uv + vec2(float(i)/u_srcW, 0.)).rgb; ws += w; }
  o = vec4(s/ws, 1.);
}`;

// vertical softness + colour controls (all before the film stock)
const FS_COLOUR = HEAD + `
uniform sampler2D u_img; uniform float u_sig; uniform vec2 u_outSize;
uniform float u_ev, u_con, u_hl, u_sh, u_sat; uniform vec3 u_wb;
void main(){
  vec3 c;
  if (u_sig < 0.2) c = texture(u_img, v_uv).rgb;
  else { int r = int(ceil(u_sig*3.)); vec3 s = vec3(0.); float ws = 0.;
    for (int i=-9;i<=9;i++){ if (abs(i)>r) continue; float w = exp(-0.5*float(i*i)/(u_sig*u_sig));
      s += w*texture(u_img, v_uv + vec2(0., float(i)/u_outSize.y)).rgb; ws += w; }
    c = s/ws; }
  vec3 lin = dec(c)*exp2(u_ev)*u_wb;
  float Y = max(dot(lin, W709), 1e-4);
  float x = log2(Y/0.18);
  float x2 = x*(1. + 0.6*u_con);
  x2 += u_hl*1.2*smoothstep(-0.5, 2.5, x);
  x2 += u_sh*1.2*(1. - smoothstep(-4.5, -0.5, x));
  float Y2 = 0.18*exp2(x2);
  lin *= Y2/Y;
  lin = max(Y2 + (lin - Y2)*(1. + u_sat), 0.);
  o = vec4(enc(min(lin, 1.)), 1.);
}`;

const ENERGY = `
uniform float u_halT, u_bloomT;
float boost(float Y){ return 1. + 3.*smoothstep(0.8, 1.0, Y); }
vec2 energy(vec3 c){ vec3 l = dec(c); float Y = dot(l, W709); float b = boost(Y); return vec2(max(Y-u_halT,0.)*b, max(Y-u_bloomT,0.)*b); }
`;

// 13-tap downsample (first level converts the picture to highlight energy: R = halation, G = bloom)
const FS_DOWN = HEAD + ENERGY + `
uniform sampler2D u_img; uniform vec2 u_texel; uniform float u_first, u_scale;
vec2 tap(vec2 off){ vec4 t = texture(u_img, v_uv + off*u_texel); return u_first > 0.5 ? energy(t.rgb) : t.rg/u_scale; }
void main(){
  vec2 e = tap(vec2(0.))*0.125;
  e += (tap(vec2(-2.,2.))+tap(vec2(2.,2.))+tap(vec2(-2.,-2.))+tap(vec2(2.,-2.)))*0.03125;
  e += (tap(vec2(0.,2.))+tap(vec2(-2.,0.))+tap(vec2(2.,0.))+tap(vec2(0.,-2.)))*0.0625;
  e += (tap(vec2(-1.,1.))+tap(vec2(1.,1.))+tap(vec2(-1.,-1.))+tap(vec2(1.,-1.)))*0.125;
  o = vec4(e*u_scale, 0., 1.);
}`;

// tent upsample + weighted level add. out: R = halation near, G = bloom, B = halation far
const FS_UP = HEAD + `
uniform sampler2D u_prev, u_lvl; uniform vec2 u_ptexel; uniform vec3 u_w; uniform float u_hasPrev, u_scale;
void main(){
  vec3 acc = vec3(0.);
  if (u_hasPrev > 0.5) {
    vec2 t = u_ptexel;
    acc += texture(u_prev, v_uv + vec2(-t.x, t.y)).rgb + texture(u_prev, v_uv + vec2(t.x, t.y)).rgb
         + texture(u_prev, v_uv + vec2(-t.x,-t.y)).rgb + texture(u_prev, v_uv + vec2(t.x,-t.y)).rgb;
    acc += 2.*(texture(u_prev, v_uv + vec2(0., t.y)).rgb + texture(u_prev, v_uv + vec2(0.,-t.y)).rgb
         + texture(u_prev, v_uv + vec2(t.x, 0.)).rgb + texture(u_prev, v_uv + vec2(-t.x, 0.)).rgb);
    acc += 4.*texture(u_prev, v_uv).rgb;
    acc /= 16.;
  }
  vec2 L = texture(u_lvl, v_uv).rg;
  acc += vec3(L.r*u_w.x, L.g*u_w.y, L.r*u_w.z);
  o = vec4(acc, 1.);
}`;

// fresh, spatially correlated grain noise every frame (4 channels: R,G,B dye layers + shared)
const FS_NOISE = HEAD + `
uniform uint u_seed;
uint pcg(uint v){ uint s = v*747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s)*277803737u; return (w >> 22u) ^ w; }
float rnd(ivec2 p, uint ch){ return float(pcg(uint(p.x) ^ pcg(uint(p.y) + pcg(ch ^ u_seed))))*(1.0/4294967295.0); }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy); vec4 n = vec4(0.);
  for (int dy=-1; dy<=1; dy++) for (int dx=-1; dx<=1; dx++){
    float w = (dx==0 && dy==0) ? 1.0 : ((dx==0 || dy==0) ? 0.2494 : 0.0622);
    ivec2 q = p + ivec2(dx,dy);
    n += w*(vec4(rnd(q,0u), rnd(q,1u), rnd(q,2u), rnd(q,3u)) - 0.5);
  }
  o = (n/0.3246)/8. + 0.5;
}`;

const FS_FINAL = HEAD + ENERGY + `
uniform sampler2D u_img, u_glow, u_nf, u_nc, u_border; uniform sampler3D u_lut;
uniform vec2 u_frameSize, u_outSize; uniform float u_lutN;
uniform float u_strength, u_hal, u_bloom, u_gscale;
uniform vec3 u_tNear, u_tFar, u_tBloom;
uniform float u_grain, u_gtone, u_gchroma, u_gbeta, u_disp, u_gamp;
uniform float u_vig, u_vigP, u_borderOn; uniform vec3 u_borderRGB;
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
  vec4 nc = (texture(u_nc, v_uv) - 0.5)*8.;
  vec2 uv = v_uv; if (u_grain > 0.) uv += nc.xy*u_disp/u_outSize;
  vec3 c = texture(u_img, uv).rgb;
  vec3 lin = dec(c); float Y = dot(lin, W709);
  // halation (spread only, red core → orange outer) and bloom, in exposure space
  vec3 g = texture(u_glow, v_uv).rgb/u_gscale;
  float hLoc = max(Y - u_halT, 0.)*boost(Y);
  lin += u_hal*(max(g.r - hLoc, 0.)*u_tNear + max(g.b - hLoc, 0.)*u_tFar);
  lin += u_bloom*g.g*u_tBloom;
  // grain: multiplicative in exposure (= additive in negative density), three dye layers, before the film curve
  if (u_grain > 0.) {
    vec4 nf = (texture(u_nf, v_uv) - 0.5)*8.;
    vec4 n = (nf + u_gbeta*nc)/sqrt(1. + u_gbeta*u_gbeta);
    vec3 nl = mix(vec3(n.a), n.rgb, u_gchroma)/sqrt((1.-u_gchroma)*(1.-u_gchroma) + u_gchroma*u_gchroma);
    vec3 e = log2(max(lin, 1e-5)/0.18);
    // grain strength vs exposure: rises into the shadows (film toe), gentle lift in highlights; tone slider tilts it
    vec3 sh = 1. + 0.9*pow(max(-e, 0.), vec3(1.32)), hi = 1. + 0.1*max(e, 0.);
    vec3 s = u_grain*u_gamp*sh*hi*exp2(u_gtone*clamp(e, -6., 2.5)*0.3)*smoothstep(-10., -6., e);
    lin *= exp2(s*nl);
  }
  // soft shoulder into the LUT domain (keeps grain alive in clipped highlights)
  lin = mix(lin, 0.9 + 0.1*tanh((lin - 0.9)/0.1), step(0.9, lin));
  c = enc(clamp(lin, 0., 1.));
  c = mix(c, texture(u_lut, c*((u_lutN-1.)/u_lutN) + 0.5/u_lutN).rgb, u_strength);
  float r = length(fpx - 0.5*u_frameSize)/length(0.5*u_frameSize);
  c = enc(dec(c)*max(1. - u_vig*pow(r, u_vigP), 0.));
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
  let n = 0, title = ''; const vals = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim(); if (!t || t[0] === '#') continue;
    if (t.startsWith('TITLE')) { title = t.replace(/^TITLE\s+/, '').replace(/"/g, ''); continue; }
    if (t.startsWith('LUT_3D_SIZE')) { n = parseInt(t.split(/\s+/)[1]); continue; }
    if (/^[A-Z_]/.test(t)) continue;
    const p = t.split(/\s+/).map(Number); if (p.length === 3 && p.every(Number.isFinite)) vals.push(p);
  }
  if (!n || vals.length !== n * n * n) throw new Error('Not a valid 3D .cube LUT');
  const half = new Uint16Array(n * n * n * 4);
  vals.forEach((v, i) => { half[i * 4] = toHalf(v[0]); half[i * 4 + 1] = toHalf(v[1]); half[i * 4 + 2] = toHalf(v[2]); half[i * 4 + 3] = 0x3c00; });
  return { n, half, title };
}

export class FilmGL {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl; this.canvas = canvas; this.rt = null; this.size = [0, 0]; this.frameNo = 0; this.useBitmap = false;
    this.floatRT = !!gl.getExtension('EXT_color_buffer_float'); gl.getExtension('OES_texture_float_linear');
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.p = { softh: this.prog(FS_SOFTH), colour: this.prog(FS_COLOUR), down: this.prog(FS_DOWN), up: this.prog(FS_UP), noise: this.prog(FS_NOISE), final: this.prog(FS_FINAL) };
    this.src = this.tex2D(); gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    this.black = this.target(1, 1, false).t; this.noiseRT = {};
  }
  prog(fs) {
    const gl = this.gl; const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.bindAttribLocation(p, 0, 'a'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
    return { p, u };
  }
  tex2D(filter, wrap) { const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, wrap || gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, wrap || gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v); return t; }
  target(w, h, float) {
    const gl = this.gl, t = this.tex2D();
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, f, w, h };
  }
  free(r) { if (!r) return; this.gl.deleteTexture(r.t); this.gl.deleteFramebuffer(r.f); }
  load({ lut, borderImage }) {
    const gl = this.gl; this.setLut(lut);
    this.border = this.tex2D(gl.LINEAR_MIPMAP_LINEAR);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, borderImage); gl.generateMipmap(gl.TEXTURE_2D);
  }
  setLut({ n, half }) {
    const gl = this.gl; if (!this.lut) this.lut = gl.createTexture(); this.lutN = n;
    gl.bindTexture(gl.TEXTURE_3D, this.lut);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, n, n, n, 0, gl.RGBA, gl.HALF_FLOAT, half);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
  }
  ensure(w, h) {
    if (this.size[0] === w && this.size[1] === h) return;
    if (this.rt) { this.free(this.rt.a); this.free(this.rt.b); for (const l of this.rt.down) this.free(l); for (const l of this.rt.up) this.free(l); }
    const down = [], up = []; let lw = w, lh = h;
    for (let i = 0; i < 8; i++) { lw = Math.max(1, Math.ceil(lw / 2)); lh = Math.max(1, Math.ceil(lh / 2)); if (Math.min(lw, lh) < 4 && i > 0) break; down.push(this.target(lw, lh, this.floatRT)); up.push(this.target(lw, lh, this.floatRT)); }
    this.rt = { a: this.target(w, h, false), b: this.target(w, h, false), down, up }; this.size = [w, h];
  }
  noiseTarget(key, w, h) {
    const r = this.noiseRT[key]; if (r && r.w === w && r.h === h) return r;
    this.free(r); const n = this.target(w, h, false); this.gl.bindTexture(this.gl.TEXTURE_2D, n.t);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.REPEAT); this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.REPEAT);
    return (this.noiseRT[key] = n);
  }
  upload(source, mip) {
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
  }
  // frame: {w,h} source size. P: shader params (see app.js). view.rect: shown part of the frame (image uv).
  render(frame, P, view = { rect: [0, 0, 1, 1] }, seed) {
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height; this.ensure(W, H);
    const rect = view.rect, k = Math.min(frame.w, frame.h) / 2160, pxScale = W / (frame.w * rect[2]);
    const gsc = this.floatRT ? 1 : 0.25;
    const use = (prog, rt, w, h) => { gl.useProgram(prog.p); gl.bindFramebuffer(gl.FRAMEBUFFER, rt ? rt.f : null); gl.viewport(0, 0, w ?? rt.w, h ?? rt.h); gl.uniform4fv(prog.u.u_srcRect, rect); return prog.u; };
    const bind = (u, name, unit, tex, target = gl.TEXTURE_2D) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, tex); gl.uniform1i(u[name], unit); };
    const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(this.vao); gl.disable(gl.BLEND);
    const soft = P.soft * k;
    let u = use(this.p.softh, this.rt.a); bind(u, 'u_src', 0, this.src); gl.uniform1f(u.u_sig, Math.min(soft, 3)); gl.uniform1f(u.u_srcW, frame.w); draw();
    u = use(this.p.colour, this.rt.b); bind(u, 'u_img', 0, this.rt.a.t); gl.uniform1f(u.u_sig, Math.min(soft * pxScale, 3)); gl.uniform2f(u.u_outSize, W, H);
    gl.uniform1f(u.u_ev, P.ev); gl.uniform1f(u.u_con, P.con); gl.uniform1f(u.u_hl, P.hl); gl.uniform1f(u.u_sh, P.sh); gl.uniform1f(u.u_sat, P.sat); gl.uniform3fv(u.u_wb, wbGains(P.temp, P.tint)); draw();
    // glow pyramid
    const D = this.rt.down, U = this.rt.up, N = D.length;
    const pxPerOut = k * pxScale;
    const wn = levelWeights(P.halR * pxPerOut, N), wf = levelWeights(P.halR * 1.7 * pxPerOut, N), wb = levelWeights(P.bloomR * pxPerOut, N);
    if (P.hal > 0 || P.bloom > 0) {
      for (let i = 0; i < N; i++) {
        const srcT = i === 0 ? this.rt.b : D[i - 1];
        u = use(this.p.down, D[i]); bind(u, 'u_img', 0, srcT.t); gl.uniform2f(u.u_texel, 1 / srcT.w, 1 / srcT.h);
        gl.uniform1f(u.u_first, i === 0 ? 1 : 0); gl.uniform1f(u.u_scale, gsc); gl.uniform1f(u.u_halT, LOOK.HAL_T); gl.uniform1f(u.u_bloomT, LOOK.BLOOM_T); draw();
      }
      for (let i = N - 1; i >= 0; i--) {
        u = use(this.p.up, U[i]); bind(u, 'u_lvl', 0, D[i].t); bind(u, 'u_prev', 1, i === N - 1 ? this.black : U[i + 1].t);
        gl.uniform1f(u.u_hasPrev, i === N - 1 ? 0 : 1); gl.uniform2f(u.u_ptexel, i === N - 1 ? 0 : 1 / U[i + 1].w, i === N - 1 ? 0 : 1 / U[i + 1].h);
        gl.uniform3f(u.u_w, wn[i], wb[i], wf[i]); gl.uniform1f(u.u_scale, gsc); draw();
      }
    }
    // grain noise (fresh every frame)
    let st = ((seed ?? this.frameNo++) * 2654435761) >>> 0;
    const t = P.gsize * pxPerOut, tf = Math.max(t, 1), tc = Math.max(3 * t, 1);
    const nf = this.noiseTarget('f', Math.ceil(W / tf) + 1, Math.ceil(H / tf) + 1), nc = this.noiseTarget('c', Math.ceil(W / tc) + 1, Math.ceil(H / tc) + 1);
    if (P.grain > 0) for (const [r, s] of [[nf, st], [nc, (st ^ 0x9e3779b9) >>> 0]]) { u = use(this.p.noise, r); gl.uniform1ui(u.u_seed, s); draw(); }
    // final
    u = use(this.p.final, null, W, H);
    bind(u, 'u_img', 0, this.rt.b.t); bind(u, 'u_glow', 1, P.hal > 0 || P.bloom > 0 ? U[0].t : this.black); bind(u, 'u_nf', 2, nf.t); bind(u, 'u_nc', 3, nc.t);
    bind(u, 'u_border', 4, this.border); bind(u, 'u_lut', 5, this.lut, gl.TEXTURE_3D);
    gl.uniform2f(u.u_frameSize, frame.w, frame.h); gl.uniform2f(u.u_outSize, W, H); gl.uniform1f(u.u_lutN, this.lutN);
    gl.uniform1f(u.u_strength, P.strength); gl.uniform1f(u.u_hal, P.hal); gl.uniform1f(u.u_bloom, P.bloom); gl.uniform1f(u.u_gscale, gsc);
    gl.uniform1f(u.u_halT, LOOK.HAL_T); gl.uniform1f(u.u_bloomT, LOOK.BLOOM_T);
    gl.uniform3fv(u.u_tNear, LOOK.HAL_NEAR); gl.uniform3fv(u.u_tFar, LOOK.HAL_FAR); gl.uniform3fv(u.u_tBloom, LOOK.BLOOM_TINT);
    gl.uniform1f(u.u_grain, P.grain); gl.uniform1f(u.u_gtone, P.gtone); gl.uniform1f(u.u_gchroma, P.gchroma); gl.uniform1f(u.u_gbeta, P.gbeta ?? 0.8);
    gl.uniform1f(u.u_disp, P.gdisp * P.gsize * pxPerOut); gl.uniform1f(u.u_gamp, Math.min(1, t * 1.15));
    gl.uniform1f(u.u_vig, P.vig); gl.uniform1f(u.u_vigP, LOOK.VIG_P); gl.uniform1f(u.u_borderOn, P.border ? 1 : 0); gl.uniform3fv(u.u_borderRGB, LOOK.BORDER_RGB);
    draw();
  }
}
// pyramid level i (0-based, half res) blurs ≈ 2^(i+1) output px
function levelWeights(R, N) {
  const c = Math.log2(Math.max(R, 1)) - 1; const w = []; let s = 0;
  for (let i = 0; i < N; i++) { const v = Math.exp(-((i - c) ** 2) / (2 * 0.65 * 0.65)); w.push(v); s += v; }
  return w.map(v => v / s);
}
// white balance gains (temperature: blue↔amber, tint: green↔magenta), luminance-neutral
export function wbGains(t, g) {
  const r = Math.pow(2, 0.32 * t + 0.08 * g), gg = Math.pow(2, -0.16 * g), b = Math.pow(2, -0.32 * t + 0.08 * g);
  const y = 0.2126 * r + 0.7152 * gg + 0.0722 * b; return [r / y, gg / y, b / y];
}
