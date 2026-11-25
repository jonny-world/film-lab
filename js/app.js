import { FilmGL, makeNoise } from './gl.js?v=1.0.0';
import { demux, mux, annexBToAvcc, avcCFromNals } from './mp4.js?v=1.0.0';

const $ = (s) => document.querySelector(s);
const VERSION = '1.0.0';

// ---------------------------------------------------------------- controls
// ui value -> shader param. Defaults are the values measured from the Dehancer render.
const CONTROLS = [
  { id: 'strength', label: 'Look', min: 0, max: 100, step: 1, def: 100, fmt: v => `${v}%`, map: v => v / 100 },
  { id: 'ev', label: 'Exposure', min: -2, max: 2, step: 0.05, def: 0, fmt: v => `${v > 0 ? '+' : ''}${(+v).toFixed(2)} EV`, map: v => +v },
  { id: 'hal', label: 'Halation', min: 0, max: 100, step: 1, def: 32, fmt: v => v, map: v => v / 100 * 0.5 },
  { id: 'bloom', label: 'Bloom', min: 0, max: 100, step: 1, def: 0, fmt: v => v, map: v => v / 100 * 0.5 },
  { id: 'grain', label: 'Grain', min: 0, max: 100, step: 1, def: 38, fmt: v => v, map: v => v / 100 * 10 / 255 },
  { id: 'gsize', label: 'Grain size', min: 0.5, max: 3, step: 0.05, def: 1.2, fmt: v => (+v).toFixed(2), map: v => +v },
  { id: 'soft', label: 'Softness', min: 0, max: 100, step: 1, def: 40, fmt: v => v, map: v => v / 100 * 3.0 },
  { id: 'vig', label: 'Vignette', min: 0, max: 100, step: 1, def: 33, fmt: v => v, map: v => v / 100 * 0.5 },
];
const state = { ui: {}, border: true, compare: false };
function loadSettings() {
  for (const c of CONTROLS) state.ui[c.id] = c.def;
  try { const s = JSON.parse(localStorage.getItem('film-lab') || '{}'); for (const c of CONTROLS) if (typeof s[c.id] === 'number') state.ui[c.id] = s[c.id]; if (typeof s.border === 'boolean') state.border = s.border; } catch {}
}
function saveSettings() { try { localStorage.setItem('film-lab', JSON.stringify({ ...state.ui, border: state.border })); } catch {} }
function params() {
  const P = {}; for (const c of CONTROLS) P[c.id] = c.map(state.ui[c.id]); P.border = state.border;
  if (state.compare) Object.assign(P, { strength: 0, ev: 0, hal: 0, bloom: 0, grain: 0, soft: 0, vig: 0, border: false });
  return P;
}
function buildControls() {
  const box = $('#sliders'); box.innerHTML = '';
  for (const c of CONTROLS) {
    const row = document.createElement('label'); row.className = 'row';
    row.innerHTML = `<span class="name">${c.label}</span><input type="range" min="${c.min}" max="${c.max}" step="${c.step}"><output></output>`;
    const inp = row.querySelector('input'), out = row.querySelector('output');
    const sync = () => { inp.value = state.ui[c.id]; out.textContent = c.fmt(state.ui[c.id]); row.classList.toggle('changed', +state.ui[c.id] !== c.def); };
    inp.addEventListener('input', () => { state.ui[c.id] = +inp.value; sync(); saveSettings(); requestPreview(); });
    let last = 0; row.querySelector('.name').addEventListener('click', (e) => { e.preventDefault(); const t = performance.now(); if (t - last < 350) { state.ui[c.id] = c.def; sync(); saveSettings(); requestPreview(); } last = t; });
    c.sync = sync; sync(); box.appendChild(row);
  }
  const b = $('#border'); b.checked = state.border; b.addEventListener('change', () => { state.border = b.checked; saveSettings(); requestPreview(); });
  $('#reset').addEventListener('click', () => { for (const c of CONTROLS) { state.ui[c.id] = c.def; c.sync(); } state.border = true; b.checked = true; saveSettings(); requestPreview(); });
}

// ---------------------------------------------------------------- assets
let assets = null;
async function loadAssets() {
  const [cubeText, borderImage] = await Promise.all([
    fetch('assets/film-lab.cube').then(r => r.text()),
    new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'assets/border.png'; }),
  ]);
  await new Promise(r => setTimeout(r, 0));
  assets = { cubeText, borderImage, noise: makeNoise(1024, 7) };
  return assets;
}

// ---------------------------------------------------------------- preview
const video = $('#video'), canvas = $('#preview');
let film = null, file = null, frameInfo = null, view = { mode: 'fit', cx: 0.5, cy: 0.5 }, hasFrame = false, pending = false;
function layoutCanvas() {
  if (!frameInfo) return;
  const wrap = $('#stage'); const cssW = wrap.clientWidth; const maxH = Math.max(200, window.innerHeight * 0.48);
  let w = cssW, h = cssW * frameInfo.h / frameInfo.w; if (h > maxH) { h = maxH; w = h * frameInfo.w / frameInfo.h; }
  canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
  const dpr = Math.min(window.devicePixelRatio || 1, 3); let pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  const cap = 1600 / Math.max(pw, ph); if (cap < 1) { pw = Math.round(pw * cap); ph = Math.round(ph * cap); }
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  requestPreview();
}
function viewRect() {
  if (view.mode === 'fit') return [0, 0, 1, 1];
  const rw = Math.min(1, canvas.width / frameInfo.w), rh = Math.min(1, canvas.height / frameInfo.h);
  const x = Math.min(Math.max(view.cx - rw / 2, 0), 1 - rw), y = Math.min(Math.max(view.cy - rh / 2, 0), 1 - rh);
  return [x, y, rw, rh];
}
function drawPreview(upload) {
  if (!film || !frameInfo) return;
  if (upload) { try { film.upload(video, true); hasFrame = true; } catch (e) { console.warn(e); } }
  if (!hasFrame) return;
  const seed = Math.round(video.currentTime * (frameInfo.fps || 25));
  film.render(frameInfo, params(), { rect: viewRect() }, seed);
}
function requestPreview() { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; drawPreview(false); }); }
function frameLoop() {
  if ('requestVideoFrameCallback' in video) { const cb = () => { drawPreview(true); updateTime(); video.requestVideoFrameCallback(cb); }; video.requestVideoFrameCallback(cb); }
  else { const tick = () => { if (!video.paused) { drawPreview(true); updateTime(); } requestAnimationFrame(tick); }; requestAnimationFrame(tick); }
}
const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
function updateTime() { const s = $('#scrub'); if (!s.matches(':active')) s.value = video.currentTime; $('#time').textContent = `${fmtT(video.currentTime)} / ${fmtT(video.duration || 0)}`; $('#play').textContent = video.paused ? 'Play' : 'Pause'; }

async function openFile(f) {
  file = f; exportResult(null);
  $('#empty').hidden = true; $('#editor').hidden = false; $('#fname').textContent = f.name;
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(f); video.muted = true; $('#mute').textContent = 'Sound off';
  await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = () => rej(new Error('This video could not be opened')); });
  frameInfo = { w: video.videoWidth, h: video.videoHeight, fps: 25 };
  $('#scrub').max = video.duration; view = { mode: 'fit', cx: 0.5, cy: 0.5 }; $('#zoom').textContent = 'Fit';
  layoutCanvas();
  try { await video.play(); video.pause(); video.currentTime = 0; } catch {}
  setTimeout(() => drawPreview(true), 150);
  demux(f).then(d => {
    frameInfo.fps = d.video.fps;
    $('#meta').textContent = `${d.video.width}×${d.video.height} · ${d.video.fps.toFixed(2)} fps · ${d.video.codecFourcc}${d.audio ? ' · audio' : ''}${d.video.rotation ? ` · rotated ${d.video.rotation}°` : ''}`;
  }).catch(e => { $('#meta').textContent = `Can't read this file for export: ${e.message}`; });
}

// ---------------------------------------------------------------- export
let cancelExport = false;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function avcCodec(w, h, fps) { const mbs = Math.ceil(w / 16) * Math.ceil(h / 16); const r = mbs * fps; if (mbs <= 8704 && r <= 522240) return 'avc1.64002a'; if (mbs <= 36864 && r <= 983040) return 'avc1.640033'; return 'avc1.640034'; }
async function pickEncoder(W, H, fps) {
  const bitrate = Math.round(Math.min(90e6, Math.max(10e6, 70e6 * (W * H) / (3840 * 2160) * Math.pow(fps / 25, 0.7))));
  const base = { width: W, height: H, bitrate, framerate: fps, latencyMode: 'quality' };
  const cands = [
    { fcc: 'avc1', cfg: { ...base, codec: avcCodec(W, H, fps), avc: { format: 'avc' } } },
    { fcc: 'avc1', cfg: { ...base, codec: 'avc1.640034', avc: { format: 'avc' } } },
    { fcc: 'hvc1', cfg: { ...base, codec: 'hvc1.1.6.L153.B0', hevc: { format: 'hevc' } } },
    { fcc: 'hvc1', cfg: { ...base, codec: 'hvc1.1.6.L156.B0' } },
  ];
  for (const c of cands) { try { const r = await VideoEncoder.isConfigSupported(c.cfg); if (r.supported) return c; } catch {} }
  throw new Error(`This browser can't encode ${W}×${H} video`);
}
async function runExport() {
  if (!file) return;
  if (!('VideoEncoder' in window) || !('VideoDecoder' in window)) { alert('This browser has no WebCodecs video encoder. Update iOS / Safari.'); return; }
  cancelExport = false; exportResult(null); setBusy(true);
  let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  const prog = (t, p) => { $('#progress').hidden = false; $('#ptext').textContent = t; if (p != null) $('#pbar').style.width = `${(p * 100).toFixed(1)}%`; };
  let decoder, encoder, ecanvas, efilm;
  try {
    prog('Reading file…', 0);
    const src = await demux(file); const v = src.video;
    const W = v.width, H = v.height, total = v.samples.length, ts = v.timescale, fps = v.fps;
    const dcfg = { codec: v.codec, codedWidth: W, codedHeight: H, description: v.description };
    const ds = await VideoDecoder.isConfigSupported(dcfg); if (!ds.supported) throw new Error(`Can't decode ${v.codec}`);
    const enc = await pickEncoder(W, H, fps);
    ecanvas = document.createElement('canvas'); ecanvas.width = W; ecanvas.height = H;
    efilm = new FilmGL(ecanvas); efilm.load(assets);
    const P = params();
    const chunks = []; let desc = null, annexB = null, encErr = null, decErr = null;
    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
        const md = meta?.decoderConfig?.description; if (md && !desc) desc = md instanceof ArrayBuffer ? new Uint8Array(md.slice(0)) : new Uint8Array(md.buffer.slice(md.byteOffset, md.byteOffset + md.byteLength));
        chunks.push({ data: d, timestamp: chunk.timestamp, key: chunk.type === 'key' });
      }, error: (e) => { encErr = e; },
    });
    encoder.configure(enc.cfg);
    const frames = []; decoder = new VideoDecoder({ output: (f) => frames.push(f), error: (e) => { decErr = e; } });
    decoder.configure(dcfg);
    const gop = Math.max(1, Math.round(fps));
    const order = v.samples; // decode order
    let fed = 0, done = 0, flushed = false, flushP = null; const t0 = performance.now();
    let readAhead = null; const read = (i) => file.slice(order[i].offset, order[i].offset + order[i].size).arrayBuffer();
    while (true) {
      if (cancelExport) throw new Error('cancelled');
      if (encErr) throw encErr; if (decErr) throw decErr;
      if (frames.length) {
        while (encoder.encodeQueueSize > 2) { await sleep(1); if (encErr) throw encErr; }
        const f = frames.shift();
        if (!efilm.useBitmap) { try { efilm.upload(f, false); } catch (e) { efilm.useBitmap = true; } }
        if (efilm.useBitmap) { const bmp = await createImageBitmap(f); efilm.upload(bmp, false); bmp.close(); }
        efilm.render({ w: W, h: H }, P, { rect: [0, 0, 1, 1] }, done + 1);
        const out = new VideoFrame(ecanvas, { timestamp: f.timestamp, duration: f.duration ?? undefined });
        f.close(); encoder.encode(out, { keyFrame: done % gop === 0 }); out.close(); done++;
        if (done % 3 === 0 || done === total) { const el = (performance.now() - t0) / 1000, rate = done / el; prog(`Rendering ${done}/${total} · ${rate.toFixed(1)} fps · ${Math.max(0, Math.round((total - done) / rate))}s left`, done / total); }
        continue;
      }
      if (fed < total && decoder.decodeQueueSize < 3 && frames.length === 0) {
        const s = order[fed]; const data = await (readAhead || read(fed)); readAhead = fed + 1 < total ? read(fed + 1) : null;
        decoder.decode(new EncodedVideoChunk({ type: s.sync ? 'key' : 'delta', timestamp: Math.round(s.cts * 1e6 / ts), duration: Math.round(s.duration * 1e6 / ts), data }));
        fed++; continue;
      }
      if (fed >= total && !flushP) { flushP = decoder.flush().then(() => { flushed = true; }); continue; }
      if (flushed && frames.length === 0) break;
      await sleep(1);
    }
    prog('Finishing…', 1);
    await encoder.flush(); if (encErr) throw encErr;
    if (!chunks.length) throw new Error('Encoder produced no frames');
    // Annex-B fallback
    if (!desc && enc.fcc === 'avc1') { for (const c of chunks) { const r = annexBToAvcc(c.data); c.data = r.data; if (!desc) desc = avcCFromNals(r.nals); } }
    if (!desc) throw new Error('Encoder did not provide codec configuration');
    const blob = mux({ src, chunks, videoConfig: { description: desc, width: W, height: H }, fcc: enc.fcc });
    const base = file.name.replace(/\.[^.]+$/, '');
    const outFile = new File([blob], `${base}_film.mp4`, { type: 'video/mp4' });
    const secs = (performance.now() - t0) / 1000;
    const cl = blob.colr; const diag = `${enc.cfg.codec}${cl ? ` · ${cl.full ? 'full' : 'video'} range · matrix ${cl.mat}` : ''} · ${efilm.useBitmap ? 'bitmap' : 'direct'} upload`;
    exportResult(outFile, `${(outFile.size / 1e6).toFixed(1)} MB · ${done} frames in ${secs.toFixed(0)}s · ${enc.cfg.codec.startsWith('avc') ? 'H.264' : 'HEVC'} ${(enc.cfg.bitrate / 1e6).toFixed(0)} Mbps${src.audio ? ' · original audio' : ''}`, diag);
    $('#progress').hidden = true;
  } catch (e) {
    console.error(e);
    prog(e.message === 'cancelled' ? 'Export cancelled' : `Export failed: ${e.message || e}`, null);
  } finally {
    try { decoder && decoder.state !== 'closed' && decoder.close(); } catch {}
    try { encoder && encoder.state !== 'closed' && encoder.close(); } catch {}
    try { efilm?.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {}
    try { await wake?.release(); } catch {}
    setBusy(false);
  }
}
let lastExport = null;
function exportResult(f, info, diag) {
  lastExport = f; $('#result').hidden = !f;
  if (f) { $('#rinfo').textContent = info; $('#diag').textContent = diag || ''; $('#download').href = URL.createObjectURL(f); $('#download').download = f.name; }
}
async function share() {
  if (!lastExport) return;
  const data = { files: [lastExport] };
  if (navigator.canShare && navigator.canShare(data)) { try { await navigator.share(data); } catch (e) { if (e.name !== 'AbortError') alert(`Share failed: ${e.message}`); } }
  else $('#download').click();
}
function setBusy(b) { document.body.classList.toggle('busy', b); $('#export').hidden = b; $('#cancel').hidden = !b; for (const el of document.querySelectorAll('#sliders input, #border, #reset, #pick2')) el.disabled = b; if (b) video.pause(); }

// ---------------------------------------------------------------- boot
async function boot() {
  $('#ver').textContent = VERSION;
  loadSettings(); buildControls();
  if (!('VideoEncoder' in window)) $('#warn').hidden = false;
  try { film = new FilmGL(canvas); } catch (e) { $('#warn').hidden = false; $('#warn').textContent = `WebGL2 unavailable: ${e.message}`; return; }
  await loadAssets(); film.load(assets);
  frameLoop();
  for (const id of ['#pick', '#pick2']) $(id).addEventListener('change', (e) => { const f = e.target.files[0]; if (f) openFile(f).catch(err => alert(err.message)); e.target.value = ''; });
  $('#play').addEventListener('click', () => { video.paused ? video.play() : video.pause(); updateTime(); });
  $('#mute').addEventListener('click', () => { video.muted = !video.muted; $('#mute').textContent = video.muted ? 'Sound off' : 'Sound on'; });
  $('#scrub').addEventListener('input', (e) => { video.currentTime = +e.target.value; });
  video.addEventListener('seeked', () => { if (!('requestVideoFrameCallback' in video)) drawPreview(true); updateTime(); });
  video.addEventListener('pause', updateTime); video.addEventListener('play', updateTime);
  const cmp = $('#compare'); const on = (e) => { e.preventDefault(); state.compare = true; cmp.classList.add('on'); requestPreview(); }, off = () => { state.compare = false; cmp.classList.remove('on'); requestPreview(); };
  cmp.addEventListener('pointerdown', on); for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) cmp.addEventListener(ev, off);
  canvas.addEventListener('click', (e) => {
    if (!frameInfo) return;
    if (view.mode === 'fit') { const r = canvas.getBoundingClientRect(); view = { mode: '1:1', cx: (e.clientX - r.left) / r.width, cy: (e.clientY - r.top) / r.height }; $('#zoom').textContent = '100%'; }
    else { view = { mode: 'fit', cx: 0.5, cy: 0.5 }; $('#zoom').textContent = 'Fit'; }
    requestPreview();
  });
  $('#export').addEventListener('click', runExport); $('#cancel').addEventListener('click', () => { cancelExport = true; });
  $('#share').addEventListener('click', share);
  window.addEventListener('resize', layoutCanvas);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); $('#warn').hidden = false; $('#warn').textContent = 'Graphics context lost — reload the page.'; });
}
window.filmLab = { get film() { return film; }, params, state, openFile, runExport, get lastExport() { return lastExport; }, assetsReady: () => !!assets };
boot().catch(e => { $('#warn').hidden = false; $('#warn').textContent = e.message; console.error(e); });
