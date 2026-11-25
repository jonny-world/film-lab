// film-lab v3 · WebGL2 film pipeline
// Per frame: film MTF (per-layer softness) → adjustments → halation/bloom pyramid → developer edge effect →
// dye-cloud grain (in exposure, before the film curve) → film-stock LUT → vignette → film gate.
// Spatial sizes are defined for a 2160-px short side and scale with resolution.
export const LOOK = {
  HAL_T: 0.20, BLOOM_T: 0.50,
  HAL_NEAR: [1.0, 0.15, 0.04], HAL_FAR: [0.45, 0.14, 0.01], BLOOM_TINT: [1.0, 0.93, 0.84],
  VIG_P: 1.87, BORDER_RGB: [13 / 255, 15 / 255, 19 / 255],
  LAYER_SOFT: [1.25, 1.0, 0.875],  // light scatter per layer (red record sits deepest → softest), after ENS Louis-Lumière 500T fit
  LAYER_GRAIN: [1.0, 1.0, 1.3],    // 500T: blue layer has the coarsest grain, red/green similar
};
// film gauges: grain radius (px @ 2160 short side), grain strength, softness and edge-effect scale
export const GAUGES = {
  '35mm': { name: '35mm', grain: 1.1, amp: 1.15, soft: 1.0, adj: 1.0 },
  '2perf': { name: '2-perf', grain: 1.65, amp: 1.2, soft: 1.15, adj: 1.15 },
  '16mm': { name: '16mm', grain: 2.4, amp: 1.45, soft: 1.35, adj: 1.3 },
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
uint pcg(uint v){ uint s = v*747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s)*277803737u; return (w >> 22u) ^ w; }
`;

// per-channel gaussian (film MTF differs per dye layer)
const BLUR = `
vec3 gblur(sampler2D t, vec2 uv, vec2 step, vec3 sig){
  float sm = max(sig.r, max(sig.g, sig.b));
  if (sm < 0.2) return texture(t, uv).rgb;
  int r = int(ceil(sm*3.)); vec3 s = vec3(0.), ws = vec3(0.); vec3 isg = 1./max(sig*sig, vec3(1e-4));
  for (int i=-12;i<=12;i++){ if (abs(i)>r) continue; float f = float(i); vec3 w = exp(-0.5*f*f*isg);
    s += w*dec(texture(t, uv + step*f).rgb); ws += w; }
  return enc(s/ws);
}`;

const FS_SOFTH = HEAD + BLUR + `
uniform sampler2D u_src; uniform vec3 u_sig; uniform float u_srcW;
void main(){ o = vec4(gblur(u_src, imgUV(), vec2(1./u_srcW, 0.), u_sig), 1.); }`;

// vertical softness + adjustments (all before the film stock)
const FS_COLOUR = HEAD + BLUR + `
uniform sampler2D u_img; uniform vec3 u_sig; uniform vec2 u_outSize;
uniform float u_ev, u_con, u_hl, u_sh, u_bl, u_sat; uniform vec3 u_wb;
void main(){
  vec3 c = gblur(u_img, v_uv, vec2(0., 1./u_outSize.y), u_sig);
  vec3 lin = dec(c)*exp2(u_ev)*u_wb;
  float Y = max(dot(lin, W709), 1e-4);
  float x = log2(Y/0.18);
  float x2 = x*(1. + 0.6*u_con);
  x2 += u_hl*1.2*smoothstep(-0.5, 2.5, x);
  x2 += u_sh*1.2*(1. - smoothstep(-4.5, -0.5, x));
  float Y2 = 0.18*exp2(x2);
  lin *= Y2/Y;
  lin = max(Y2 + (lin - Y2)*(1. + u_sat), 0.);
  // blacks: moves the black point (lift / crush), only below ~20% linear
  lin = max(lin + u_bl*0.006*(1. - smoothstep(0.0, 0.2, lin)), 0.);
  o = vec4(enc(min(lin, 1.)), 1.);
}`;

const ENERGY = `
uniform float u_halT, u_bloomT;
float boost(float Y){ return 1. + 3.*smoothstep(0.8, 1.0, Y); }
vec3 energy(vec3 c){ vec3 l = dec(c); float Y = dot(l, W709); float b = boost(Y); return vec3(max(Y-u_halT,0.)*b, max(Y-u_bloomT,0.)*b, pow(Y, 1./2.4)); }
`;

// 13-tap downsample. Level 0: R = halation energy, G = bloom energy, B = encoded luminance (for the edge effect)
const FS_DOWN = HEAD + ENERGY + `
uniform sampler2D u_img; uniform vec2 u_texel; uniform float u_first, u_scale;
vec3 tap(vec2 off){ vec4 t = texture(u_img, v_uv + off*u_texel); return u_first > 0.5 ? energy(t.rgb) : vec3(t.rg/u_scale, t.b); }
void main(){
  vec3 e = tap(vec2(0.))*0.125;
  e += (tap(vec2(-2.,2.))+tap(vec2(2.,2.))+tap(vec2(-2.,-2.))+tap(vec2(2.,-2.)))*0.03125;
  e += (tap(vec2(0.,2.))+tap(vec2(-2.,0.))+tap(vec2(2.,0.))+tap(vec2(0.,-2.)))*0.0625;
  e += (tap(vec2(-1.,1.))+tap(vec2(1.,1.))+tap(vec2(-1.,-1.))+tap(vec2(1.,-1.)))*0.125;
  o = vec4(e.rg*u_scale, e.b, 1.);
}`;

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

const FS_FINAL = HEAD + ENERGY + `
uniform sampler2D u_img, u_glow, u_lum, u_border; uniform sampler3D u_lut;
uniform vec2 u_frameSize, u_outSize; uniform float u_lutN;
uniform float u_strength, u_hal, u_bloom, u_gscale, u_adj;
uniform vec3 u_tNear, u_tFar, u_tBloom;
uniform float u_grain, u_rc, u_rf, u_gmix, u_gdev0, u_gnorm, u_ss; uniform uint u_seed; uniform vec3 u_glayer;
uniform float u_vig, u_vigP, u_borderOn; uniform vec3 u_borderRGB;
float slice(float q, float D, float P){ const float C = 240.;
  if (q < C) return q; if (q > D - C) return P - (D - q); return C + (q - C)*(P - 2.*C)/max(D - 2.*C, 1.); }
vec2 borderUV(vec2 fuv){
  vec2 p = fuv*u_frameSize, D = u_frameSize;
  if (D.y > D.x) { p = p.yx; D = D.yx; }
  float s = D.y/2160.; vec2 q = p/s, Dq = D/s;
  return vec2(slice(q.x, Dq.x, 3840.), slice(q.y, Dq.y, 2160.)) / vec2(3840.,2160.);
}
// Dye clouds of one emulsion: soft, semi-transparent, log-normally sized, scattered in cells; each develops with
// probability p. Returns (coverage, expected coverage).
vec2 dye(vec2 px, float r, float p, uint salt){
  float c = 1.4*r; vec2 cell = floor(px/c); float inv = 1.;
  for (int j=-1;j<=1;j++) for (int i=-1;i<=1;i++){
    ivec2 id = ivec2(cell) + ivec2(i,j);
    uint h = pcg(uint(id.x + 65536) ^ pcg(uint(id.y + 65536) ^ pcg(salt ^ u_seed)));
    uint h2 = pcg(h), h3 = pcg(h2), h4 = pcg(h3);
    if (float(h4)*(1./4294967295.) > p) continue;
    vec2 ctr = (vec2(id) + vec2(float(h), float(h2))*(1./4294967295.))*c;
    float rad = r*exp(0.55*(float(h3)*(2./4294967295.) - 1.));
    float w = clamp((rad - length(px - ctr))/max(0.75*rad, 0.8/u_ss) + 0.5, 0., 1.);
    inv *= 1. - 0.7*w;
  }
  return vec2(1. - inv, 1. - exp(-(1.35 + 0.372*p)*p));
}
// One dye layer = fast coarse emulsion (develops first: shadows) + slow fine emulsion (mids/highlights).
float layerGrain(vec2 px, float s, float e, uint salt){
  float pf = 0.06 + 0.94/(1. + exp(-(e + 2.5 - u_gdev0)/1.2));
  float ps = 1./(1. + exp(-(e - 1.4 - u_gdev0)/0.9));
  vec2 a = dye(px, u_rc*s, pf, salt), b = dye(px, u_rf*s, ps, salt + 101u);
  return 1.5*(a.x - a.y)*(1. - b.y) + (b.x - b.y)*(1. - a.y);   // thin (shadow) areas print grainy: coarse layer weighted up
}
void main(){
  vec2 fuv = imgUV(); vec2 fpx = fuv*u_frameSize;
  vec3 c = texture(u_img, v_uv).rgb;
  vec3 lin = dec(c); float Y = dot(lin, W709);
  // developer edge (adjacency) effect: local contrast in log exposure at the scale of the emulsion
  if (u_adj > 0.) { float yb = pow(texture(u_lum, v_uv).b, 2.4); lin *= exp2(u_adj*clamp(log2(max(Y,1e-4)/max(yb,1e-4)), -1.5, 1.5)); Y = dot(lin, W709); }
  // halation (spread only, red core → orange outer) and bloom, in exposure space
  vec3 g = texture(u_glow, v_uv).rgb/u_gscale;
  float hLoc = max(Y - u_halT, 0.)*boost(Y);
  lin += u_hal*(max(g.r - hLoc, 0.)*u_tNear + max(g.b - hLoc, 0.)*u_tFar);
  lin += u_bloom*g.g*u_tBloom;
  // dye-cloud grain in exposure (negative density) space, before the film curve
  if (u_grain > 0.) {
    vec3 e = log2(max(lin, 1e-5)/0.18), g3 = vec3(0.);
    int n = int(u_ss);
    for (int sy=0; sy<2; sy++) for (int sx=0; sx<2; sx++) {
      if (sx >= n || sy >= n) continue;
      vec2 gp = gl_FragCoord.xy + (vec2(sx, sy) + 0.5)/u_ss - 0.5;
      g3 += vec3(layerGrain(gp, u_glayer.r, e.r, 11u), layerGrain(gp, u_glayer.g, e.g, 23u), layerGrain(gp, u_glayer.b, e.b, 37u));
    }
    g3 /= u_ss*u_ss;
    // layers stack in the emulsion: mix them to set how colourful the grain is
    g3 = (g3 + u_gmix*(g3.gbr + g3.brg))/sqrt(1. + 2.*u_gmix*u_gmix);
    lin *= exp2(u_grain*u_gnorm*g3);
  }
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
    this.p = { softh: this.prog(FS_SOFTH), colour: this.prog(FS_COLOUR), down: this.prog(FS_DOWN), up: this.prog(FS_UP), final: this.prog(FS_FINAL) };
    this.src = this.tex2D(); gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    this.black = this.target(1, 1, false).t;
  }
  prog(fs) {
    const gl = this.gl; const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.bindAttribLocation(p, 0, 'a'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
    return { p, u };
  }
  tex2D(filter) { const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v); return t; }
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
  upload(source, mip) {
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
  }
  // frame: {w,h} source size. P: shader params (see app.js). view.rect: shown part of the frame (image uv).
  render(frame, P, view = { rect: [0, 0, 1, 1] }, seed) {
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height; this.ensure(W, H);
    const rect = view.rect, k = Math.min(frame.w, frame.h) / 2160, pxScale = W / (frame.w * rect[2]), pxPerOut = k * pxScale;
    const G = GAUGES[P.gauge] || GAUGES['16mm'];
    const gsc = this.floatRT ? 1 : 0.25;
    const use = (prog, rt, w, h) => { gl.useProgram(prog.p); gl.bindFramebuffer(gl.FRAMEBUFFER, rt ? rt.f : null); gl.viewport(0, 0, w ?? rt.w, h ?? rt.h); gl.uniform4fv(prog.u.u_srcRect, rect); return prog.u; };
    const bind = (u, name, unit, tex, target = gl.TEXTURE_2D) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, tex); gl.uniform1i(u[name], unit); };
    const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(this.vao); gl.disable(gl.BLEND);
    const soft = P.soft * G.soft * k, sig = LOOK.LAYER_SOFT.map(m => Math.min(soft * m, 4));
    let u = use(this.p.softh, this.rt.a); bind(u, 'u_src', 0, this.src); gl.uniform3fv(u.u_sig, sig); gl.uniform1f(u.u_srcW, frame.w); draw();
    u = use(this.p.colour, this.rt.b); bind(u, 'u_img', 0, this.rt.a.t); gl.uniform3fv(u.u_sig, sig.map(s => s * pxScale)); gl.uniform2f(u.u_outSize, W, H);
    gl.uniform1f(u.u_ev, P.ev); gl.uniform1f(u.u_con, P.con); gl.uniform1f(u.u_hl, P.hl); gl.uniform1f(u.u_sh, P.sh); gl.uniform1f(u.u_bl, P.bl ?? 0); gl.uniform1f(u.u_sat, P.sat); gl.uniform3fv(u.u_wb, wbGains(P.temp, P.tint)); draw();
    // pyramid: level 0 always (edge effect), the rest only when glow is on
    const D = this.rt.down, U = this.rt.up, N = D.length, glow = P.hal > 0 || P.bloom > 0;
    const wn = levelWeights(P.halR * pxPerOut, N), wf = levelWeights(P.halR * 1.7 * pxPerOut, N), wb = levelWeights(P.bloomR * pxPerOut, N);
    for (let i = 0; i < (glow ? N : Math.min(2, N)); i++) {
      const srcT = i === 0 ? this.rt.b : D[i - 1];
      u = use(this.p.down, D[i]); bind(u, 'u_img', 0, srcT.t); gl.uniform2f(u.u_texel, 1 / srcT.w, 1 / srcT.h);
      gl.uniform1f(u.u_first, i === 0 ? 1 : 0); gl.uniform1f(u.u_scale, gsc); gl.uniform1f(u.u_halT, LOOK.HAL_T); gl.uniform1f(u.u_bloomT, LOOK.BLOOM_T); draw();
    }
    if (glow) for (let i = N - 1; i >= 0; i--) {
      u = use(this.p.up, U[i]); bind(u, 'u_lvl', 0, D[i].t); bind(u, 'u_prev', 1, i === N - 1 ? this.black : U[i + 1].t);
      gl.uniform1f(u.u_hasPrev, i === N - 1 ? 0 : 1); gl.uniform2f(u.u_ptexel, i === N - 1 ? 0 : 1 / U[i + 1].w, i === N - 1 ? 0 : 1 / U[i + 1].h);
      gl.uniform3f(u.u_w, wn[i], wb[i], wf[i]); gl.uniform1f(u.u_scale, gsc); draw();
    }
    // final
    u = use(this.p.final, null, W, H);
    bind(u, 'u_img', 0, this.rt.b.t); bind(u, 'u_glow', 1, glow ? U[0].t : this.black); bind(u, 'u_lum', 2, D[Math.min(1, N - 1)].t);
    bind(u, 'u_border', 3, this.border); bind(u, 'u_lut', 4, this.lut, gl.TEXTURE_3D);
    gl.uniform2f(u.u_frameSize, frame.w, frame.h); gl.uniform2f(u.u_outSize, W, H); gl.uniform1f(u.u_lutN, this.lutN);
    gl.uniform1f(u.u_strength, P.strength); gl.uniform1f(u.u_hal, P.hal); gl.uniform1f(u.u_bloom, P.bloom); gl.uniform1f(u.u_gscale, gsc);
    gl.uniform1f(u.u_halT, LOOK.HAL_T); gl.uniform1f(u.u_bloomT, LOOK.BLOOM_T);
    gl.uniform3fv(u.u_tNear, LOOK.HAL_NEAR); gl.uniform3fv(u.u_tFar, LOOK.HAL_FAR); gl.uniform3fv(u.u_tBloom, LOOK.BLOOM_TINT);
    // edge effect fades out when the half-res level is finer than ~1 output px (preview)
    gl.uniform1f(u.u_adj, (P.adj ?? 0) * G.adj * Math.min(1, pxPerOut * 2));
    // grain: coarse (fast) and fine (slow) emulsion radii in output px; supersample 2×2 when grains are sub-pixel (preview)
    const rg = G.grain * P.gsize * pxPerOut, ss = rg * 0.7 < 1.2 ? 2 : 1;
    gl.uniform1f(u.u_grain, P.grain * G.amp); gl.uniform1f(u.u_rc, rg * 1.5); gl.uniform1f(u.u_rf, rg * 0.7); gl.uniform1f(u.u_ss, ss);
    gl.uniform1f(u.u_gmix, Math.pow(1 - P.gchroma, 1.5)); gl.uniform1f(u.u_gdev0, 1.5 * P.gtone); gl.uniform1f(u.u_gnorm, 5.0);
    gl.uniform3fv(u.u_glayer, LOOK.LAYER_GRAIN); gl.uniform1ui(u.u_seed, (((seed ?? this.frameNo++) + 1) * 2654435761) >>> 0);
    gl.uniform1f(u.u_vig, P.vig); gl.uniform1f(u.u_vigP, LOOK.VIG_P); gl.uniform1f(u.u_borderOn, P.border ? 1 : 0); gl.uniform3fv(u.u_borderRGB, LOOK.BORDER_RGB);
    draw();
  }
}
function levelWeights(R, N) {
  const c = Math.log2(Math.max(R, 1)) - 1; const w = []; let s = 0;
  for (let i = 0; i < N; i++) { const v = Math.exp(-((i - c) ** 2) / (2 * 0.65 * 0.65)); w.push(v); s += v; }
  return w.map(v => v / s);
}
export function wbGains(t, g) {
  const r = Math.pow(2, 0.32 * t + 0.08 * g), gg = Math.pow(2, -0.16 * g), b = Math.pow(2, -0.32 * t + 0.08 * g);
  const y = 0.2126 * r + 0.7152 * gg + 0.0722 * b; return [r / y, gg / y, b / y];
}
