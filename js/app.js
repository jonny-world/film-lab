import { FilmGL, parseCube, GAUGES } from './gl.js?v=2.1.0';
import { demux, mux, annexBToAvcc, avcCFromNals } from './mp4.js?v=2.1.0';

const $ = (s) => document.querySelector(s);
const VERSION = '2.1.0', BUILD_DATE = '25 Nov 2026';

// ---------------------------------------------------------------- controls
// ui value → shader param. Defaults reproduce the Dehancer render this look was fitted to.
const pw = (base, ref, e) => (v) => base * Math.pow(v / ref, e);
const SECTIONS = [
  { id: 'film', title: 'Film', open: true, controls: [
    { id: 'strength', label: 'Strength', min: 0, max: 100, step: 1, def: 100, fmt: v => `${v}%`, map: v => v / 100 },
  ] },
  { id: 'colour', title: 'Adjust', controls: [
    { id: 'ev', label: 'Exposure', min: -2, max: 2, step: 0.05, def: 0, fmt: v => `${v > 0 ? '+' : ''}${(+v).toFixed(2)}`, map: v => +v },
    { id: 'temp', label: 'Temperature', min: -100, max: 100, step: 1, def: 0, fmt: sgn, map: v => v / 100 },
    { id: 'tint', label: 'Tint', min: -100, max: 100, step: 1, def: 0, fmt: sgn, map: v => v / 100 },
    { id: 'con', label: 'Contrast', min: -100, max: 100, step: 1, def: 0, fmt: sgn, map: v => v / 100 },
    { id: 'hl', label: 'Highlights', min: -100, max: 100, step: 1, def: 0, fmt: sgn, map: v => v / 100 },
    { id: 'sh', label: 'Shadows', min: -100, max: 100, step: 1, def: 0, fmt: sgn, map: v => v / 100 },
    { id: 'bl', label: 'Blacks', min: -100, max: 100, step: 1, def: 0, fmt: sgn, map: v => v / 100 },
    { id: 'sat', label: 'Saturation', min: -100, max: 100, step: 1, def: 0, fmt: sgn, map: v => v / 100 },
  ] },
  { id: 'glow', title: 'Halation & bloom', controls: [
    { id: 'hal', label: 'Halation', min: 0, max: 100, step: 1, def: 30, fmt: v => v, map: pw(0.40, 30, 1.5) },
    { id: 'halR', label: 'Halation size', min: 0, max: 100, step: 1, def: 32, fmt: v => v, map: v => 4 * Math.pow(2, (v - 40) / 20) },
    { id: 'bloom', label: 'Bloom', min: 0, max: 100, step: 1, def: 0, fmt: v => v, map: pw(0.15, 30, 1.5) },
    { id: 'bloomR', label: 'Bloom size', min: 0, max: 100, step: 1, def: 50, fmt: v => v, map: v => 54 * Math.pow(2, (v - 50) / 25) },
  ] },
  { id: 'grainS', title: 'Grain', gauge: true, controls: [
    { id: 'grain', label: 'Amount', min: 0, max: 100, step: 1, def: 35, fmt: v => v, map: pw(0.10, 35, 1.2) },
    { id: 'gsize', label: 'Size', min: 0.5, max: 2.5, step: 0.05, def: 1, fmt: v => (+v).toFixed(2), map: v => +v },
    { id: 'gchroma', label: 'Colour', min: 0, max: 100, step: 1, def: 20, fmt: v => v, map: v => v / 100 },
    { id: 'gtone', label: 'Tone balance', min: -100, max: 100, step: 1, def: 0, fmt: sgn, map: v => v / 100 },
  ] },
  { id: 'lens', title: 'Lens & gate', controls: [
    { id: 'soft', label: 'Softness', min: 0, max: 100, step: 1, def: 40, fmt: v => v, map: v => v / 100 * 3.0 },
    { id: 'adj', label: 'Edge effect', min: 0, max: 100, step: 1, def: 25, fmt: v => v, map: v => v / 100 },
    { id: 'vig', label: 'Vignette', min: 0, max: 100, step: 1, def: 33, fmt: v => v, map: v => v / 100 * 0.5 },
  ], toggle: true },
];
function sgn(v) { return v > 0 ? `+${v}` : `${v}`; }
const CONTROLS = SECTIONS.flatMap(s => s.controls);
const KEY = 'film-lab-v3';
const state = { ui: {}, border: true, compare: false, stock: 'yosemite', gauge: '16mm', open: {} };
function loadSettings() {
  for (const c of CONTROLS) state.ui[c.id] = c.def;
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const c of CONTROLS) if (typeof s.ui?.[c.id] === 'number') state.ui[c.id] = s.ui[c.id];
    if (typeof s.border === 'boolean') state.border = s.border; if (s.stock) state.stock = s.stock; if (s.open) state.open = s.open; if (GAUGES[s.gauge]) state.gauge = s.gauge;
  } catch {}
}
function saveSettings() { try { localStorage.setItem(KEY, JSON.stringify({ ui: state.ui, border: state.border, stock: state.stock, gauge: state.gauge, open: state.open })); } catch {} }
function params() {
  const P = {}; for (const c of CONTROLS) P[c.id] = c.map(state.ui[c.id]); P.border = state.border; P.gauge = state.gauge;
  if (state.compare) Object.assign(P, { strength: 0, ev: 0, temp: 0, tint: 0, con: 0, hl: 0, sh: 0, bl: 0, sat: 0, hal: 0, bloom: 0, grain: 0, soft: 0, adj: 0, vig: 0, border: false });
  return P;
}
function buildControls() {
  const box = $('#sections'); box.innerHTML = '';
  for (const sec of SECTIONS) {
    const d = document.createElement('details'); d.className = 'sec'; d.open = state.open[sec.id] ?? !!sec.open;
    d.innerHTML = `<summary><span>${sec.title}</span><i class="dot"></i><b class="chev"></b></summary><div class="body"></div>`;
    d.addEventListener('toggle', () => { state.open[sec.id] = d.open; saveSettings(); });
    const body = d.querySelector('.body');
    if (sec.id === 'film') body.appendChild($('#stockTpl').content.cloneNode(true));
    if (sec.gauge) { const g = document.createElement('div'); g.className = 'gauges'; for (const [id, G] of Object.entries(GAUGES)) { const b = document.createElement('button'); b.className = 'chip gauge' + (id === state.gauge ? ' on' : ''); b.textContent = G.name; b.dataset.id = id; b.addEventListener('click', () => { state.gauge = id; g.querySelectorAll('.gauge').forEach(x => x.classList.toggle('on', x.dataset.id === id)); saveSettings(); requestPreview(); }); g.appendChild(b); } body.appendChild(g); }
    for (const c of sec.controls) {
      const row = document.createElement('div'); row.className = 'row';
      row.innerHTML = `<span class="name">${c.label}</span><input type="range" min="${c.min}" max="${c.max}" step="${c.step}"><output></output>`;
      const inp = row.querySelector('input'), out = row.querySelector('output');
      c.sync = () => { inp.value = state.ui[c.id]; out.textContent = c.fmt(state.ui[c.id]); row.classList.toggle('changed', +state.ui[c.id] !== c.def); markSections(); };
      inp.addEventListener('input', () => { state.ui[c.id] = +inp.value; c.sync(); saveSettings(); requestPreview(); });
      let last = 0; row.querySelector('.name').addEventListener('click', () => { const t = performance.now(); if (t - last < 350) { state.ui[c.id] = c.def; c.sync(); saveSettings(); requestPreview(); } last = t; });
      body.appendChild(row); c.sec = sec.id;
    }
    if (sec.toggle) { const t = document.createElement('div'); t.className = 'toggle'; t.innerHTML = '<span class="name">Film border</span><label class="switch"><input id="border" type="checkbox"><span></span></label>'; body.appendChild(t); }
    if (sec.id !== 'film') { const r = document.createElement('button'); r.className = 'btn small'; r.textContent = `Reset ${sec.title.toLowerCase()}`; r.addEventListener('click', () => { for (const c of sec.controls) { state.ui[c.id] = c.def; c.sync(); } if (sec.toggle) { state.border = true; $('#border').checked = true; } saveSettings(); requestPreview(); }); body.appendChild(r); }
    box.appendChild(d); sec.el = d;
  }
  for (const c of CONTROLS) c.sync();
  const b = $('#border'); b.checked = state.border; b.addEventListener('change', () => { state.border = b.checked; saveSettings(); requestPreview(); });
}
function markSections() { for (const s of SECTIONS) if (s.el) s.el.classList.toggle('changed', s.controls.some(c => +state.ui[c.id] !== c.def)); }

// ---------------------------------------------------------------- film stocks
let stocks = [], lutCache = {}, borderImage = null;
const IMP = 'film-lab-luts';
const b64 = { enc: (u16) => { const u8 = new Uint8Array(u16.buffer); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); },
  dec: (s) => { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return new Uint16Array(u8.buffer); } };
function imported() { try { return JSON.parse(localStorage.getItem(IMP) || '[]'); } catch { return []; } }
async function loadStocks() {
  const builtIn = await fetch('assets/luts/index.json', { cache: 'no-cache' }).then(r => r.json());
  stocks = [...builtIn.map(s => ({ ...s, builtIn: true })), ...imported().map(s => ({ id: s.id, name: s.name, sub: 'Imported', imported: true }))];
  if (!stocks.find(s => s.id === state.stock)) state.stock = stocks[0].id;
}
async function getLut(id) {
  if (lutCache[id]) return lutCache[id];
  const s = stocks.find(x => x.id === id);
  if (s.builtIn) { const text = await fetch(s.file).then(r => r.text()); lutCache[id] = { ...parseCube(text), text }; }
  else { const e = imported().find(x => x.id === id); lutCache[id] = { n: e.n, half: b64.dec(e.b64) }; }
  return lutCache[id];
}
function renderStocks() {
  const box = $('#stocks'); box.innerHTML = '';
  for (const s of stocks) {
    const b = document.createElement('button'); b.className = 'chip' + (s.id === state.stock ? ' on' : ''); b.innerHTML = `<span>${esc(s.name)}</span><small>${esc(s.sub || '')}</small>`;
    b.addEventListener('click', () => selectStock(s.id)); box.appendChild(b);
  }
  const cur = stocks.find(s => s.id === state.stock); $('#removeLut').hidden = !cur?.imported;
}
const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function selectStock(id) { state.stock = id; saveSettings(); renderStocks(); film?.setLut(await getLut(id)); requestPreview(); }
async function importCube(f) {
  const text = await f.text(); const lut = parseCube(text);
  const id = 'imp-' + Date.now().toString(36), name = (lut.title || f.name.replace(/\.cube$/i, '')).slice(0, 28);
  const list = imported(); list.push({ id, name, n: lut.n, b64: b64.enc(lut.half) });
  try { localStorage.setItem(IMP, JSON.stringify(list)); } catch { alert('Not enough storage to keep this LUT — remove an imported one first.'); return; }
  lutCache[id] = lut; stocks.push({ id, name, sub: 'Imported', imported: true }); await selectStock(id);
}
function removeStock() {
  const id = state.stock; localStorage.setItem(IMP, JSON.stringify(imported().filter(x => x.id !== id)));
  stocks = stocks.filter(s => s.id !== id); delete lutCache[id]; selectStock(stocks[0].id);
}
function halfToFloat(h) { const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023; return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15); }
async function shareLut() {
  const s = stocks.find(x => x.id === state.stock), lut = await getLut(s.id);
  let text = lut.text;
  if (!text) { const n = lut.n, lines = [`TITLE "${s.name}"`, `LUT_3D_SIZE ${n}`]; for (let i = 0; i < n * n * n; i++) lines.push([0, 1, 2].map(c => halfToFloat(lut.half[i * 4 + c]).toFixed(6)).join(' ')); text = lines.join('\n') + '\n'; }
  const file = new File([text], `${s.name.replace(/[^\w-]+/g, '_')}.cube`, { type: 'application/octet-stream' });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file] }); } catch {} } else alert('Sharing files is not supported in this browser.');
}

// ---------------------------------------------------------------- preview
const video = $('#video'), canvas = $('#preview');
let film = null, file = null, frameInfo = null, view = { mode: 'fit', cx: 0.5, cy: 0.5 }, hasFrame = false, pending = false;
function layoutCanvas() {
  if (!frameInfo) return;
  const wrap = $('#stage'); const cssW = wrap.clientWidth - 24; const maxH = Math.max(200, window.innerHeight * 0.42);
  let w = cssW, h = cssW * frameInfo.h / frameInfo.w; if (h > maxH) { h = maxH; w = h * frameInfo.w / frameInfo.h; }
  canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
  const dpr = Math.min(window.devicePixelRatio || 1, 3); let pw_ = Math.round(w * dpr), ph = Math.round(h * dpr);
  const cap = 1600 / Math.max(pw_, ph); if (cap < 1) { pw_ = Math.round(pw_ * cap); ph = Math.round(ph * cap); }
  if (canvas.width !== pw_ || canvas.height !== ph) { canvas.width = pw_; canvas.height = ph; }
  requestPreview();
}
function viewRect() {
  if (view.mode === 'fit') return [0, 0, 1, 1];
  const rw = Math.min(1, canvas.width / frameInfo.w), rh = Math.min(1, canvas.height / frameInfo.h);
  return [Math.min(Math.max(view.cx - rw / 2, 0), 1 - rw), Math.min(Math.max(view.cy - rh / 2, 0), 1 - rh), rw, rh];
}
function drawPreview(upload) {
  if (!film || !frameInfo) return;
  if (upload) { try { film.upload(video, true); hasFrame = true; } catch (e) { console.warn(e); } }
  if (!hasFrame) return;
  film.render(frameInfo, params(), { rect: viewRect() }, Math.round(video.currentTime * (frameInfo.fps || 25)));
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
  $('#empty').hidden = true; $('#editor').hidden = false; $('#fname').textContent = f.name; document.body.classList.add('editing');
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(f); video.muted = true; $('#mute').textContent = 'Sound off';
  await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = () => rej(new Error('This video could not be opened')); });
  frameInfo = { w: video.videoWidth, h: video.videoHeight, fps: 25 };
  $('#scrub').max = video.duration; view = { mode: 'fit', cx: 0.5, cy: 0.5 }; $('#zoom').textContent = 'Fit';
  layoutCanvas();
  try { await video.play(); video.pause(); video.currentTime = 0; } catch {}
  setTimeout(() => drawPreview(true), 150);
  demux(f).then(d => { frameInfo.fps = d.video.fps; $('#meta').textContent = `${d.video.width}×${d.video.height} · ${d.video.fps.toFixed(2)} fps · ${d.video.codecFourcc}${d.audio ? ' · audio' : ''}${d.video.rotation ? ` · ${d.video.rotation}°` : ''}`; })
    .catch(e => { $('#meta').textContent = `Can't read this file for export: ${e.message}`; });
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
    efilm = new FilmGL(ecanvas); efilm.load({ lut: await getLut(state.stock), borderImage });
    const P = { ...params() };
    const chunks = []; let desc = null, encErr = null, decErr = null;
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
    const gop = Math.max(1, Math.round(fps)); const order = v.samples;
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
      if (fed < total && decoder.decodeQueueSize < 3) {
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
    if (!desc && enc.fcc === 'avc1') { for (const c of chunks) { const r = annexBToAvcc(c.data); c.data = r.data; if (!desc) desc = avcCFromNals(r.nals); } }
    if (!desc) throw new Error('Encoder did not provide codec configuration');
    const blob = mux({ src, chunks, videoConfig: { description: desc, width: W, height: H }, fcc: enc.fcc });
    const outFile = new File([blob], `${file.name.replace(/\.[^.]+$/, '')}_film.mp4`, { type: 'video/mp4' });
    const secs = (performance.now() - t0) / 1000, cl = blob.colr;
    exportResult(outFile, `${(outFile.size / 1e6).toFixed(1)} MB · ${done} frames in ${secs.toFixed(0)}s · ${enc.cfg.codec.startsWith('avc') ? 'H.264' : 'HEVC'} ${(enc.cfg.bitrate / 1e6).toFixed(0)} Mbps${src.audio ? ' · original audio' : ''}`,
      `v${VERSION} · ${enc.cfg.codec}${cl ? ` · ${cl.full ? 'full' : 'video'} range · matrix ${cl.mat}` : ''} · ${efilm.useBitmap ? 'bitmap' : 'direct'} upload · ${efilm.floatRT ? 'float' : '8-bit'} glow`);
    $('#progress').hidden = true;
  } catch (e) {
    console.error(e); prog(e.message === 'cancelled' ? 'Export cancelled' : `Export failed: ${e.message || e}`, null);
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
  if (f) { $('#rinfo').textContent = info; $('#diag').textContent = diag || ''; $('#download').href = URL.createObjectURL(f); $('#download').download = f.name; $('#result').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}
async function share() {
  if (!lastExport) return; const data = { files: [lastExport] };
  if (navigator.canShare && navigator.canShare(data)) { try { await navigator.share(data); } catch (e) { if (e.name !== 'AbortError') alert(`Share failed: ${e.message}`); } }
  else $('#download').click();
}
function setBusy(b) { document.body.classList.toggle('busy', b); $('#export').hidden = b; $('#cancel').hidden = !b; for (const el of document.querySelectorAll('#sections input, #sections button, #pick2')) el.disabled = b; if (b) video.pause(); }

// ---------------------------------------------------------------- updates
async function checkUpdate(manual) {
  const st = $('#upd');
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' }).then(r => r.json());
    if (r.version !== VERSION) { st.innerHTML = `New version <b>v${esc(r.version)}</b> available. <button class="btn small" id="doUpd">Update now</button>`; $('#doUpd').addEventListener('click', () => location.replace(`./?v=${encodeURIComponent(r.version)}`)); $('#updBadge').hidden = false; }
    else if (manual) st.textContent = 'You are on the latest version.';
  } catch { if (manual) st.textContent = 'Could not check (offline?).'; }
}

// ---------------------------------------------------------------- boot
async function boot() {
  $('#ver').textContent = VERSION; $('#ver2').textContent = `v${VERSION}`; $('#date').textContent = BUILD_DATE;
  loadSettings(); buildControls();
  if (!('VideoEncoder' in window)) $('#warn').hidden = false;
  try { film = new FilmGL(canvas); } catch (e) { $('#warn').hidden = false; $('#warn').textContent = `WebGL2 unavailable: ${e.message}`; return; }
  borderImage = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'assets/border.png'; });
  await loadStocks(); renderStocks(); film.load({ lut: await getLut(state.stock), borderImage });
  frameLoop();
  for (const id of ['#pick', '#pick2']) $(id).addEventListener('change', (e) => { const f = e.target.files[0]; if (f) openFile(f).catch(err => alert(err.message)); e.target.value = ''; });
  $('#importLut').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importCube(f).catch(err => alert(err.message)); e.target.value = ''; });
  $('#removeLut').addEventListener('click', removeStock);
  $('#shareLut').addEventListener('click', shareLut);
  $('#play').addEventListener('click', () => { video.paused ? video.play() : video.pause(); updateTime(); });
  $('#mute').addEventListener('click', () => { video.muted = !video.muted; $('#mute').textContent = video.muted ? 'Sound off' : 'Sound on'; });
  $('#scrub').addEventListener('input', (e) => { video.currentTime = +e.target.value; });
  video.addEventListener('seeked', () => { if (!('requestVideoFrameCallback' in video)) drawPreview(true); updateTime(); });
  video.addEventListener('pause', updateTime); video.addEventListener('play', updateTime);
  $('#compare').addEventListener('click', () => { state.compare = !state.compare; $('#compare').classList.toggle('on', state.compare); $('#compare').textContent = state.compare ? 'Showing original' : 'Before / after'; requestPreview(); });
  canvas.addEventListener('click', (e) => {
    if (!frameInfo) return;
    if (view.mode === 'fit') { const r = canvas.getBoundingClientRect(); view = { mode: '1:1', cx: (e.clientX - r.left) / r.width, cy: (e.clientY - r.top) / r.height }; $('#zoom').textContent = '100%'; }
    else { view = { mode: 'fit', cx: 0.5, cy: 0.5 }; $('#zoom').textContent = 'Fit'; }
    requestPreview();
  });
  $('#zoom').addEventListener('click', () => { view = view.mode === 'fit' ? { mode: '1:1', cx: 0.5, cy: 0.5 } : { mode: 'fit', cx: 0.5, cy: 0.5 }; $('#zoom').textContent = view.mode === 'fit' ? 'Fit' : '100%'; requestPreview(); });
  $('#export').addEventListener('click', runExport); $('#cancel').addEventListener('click', () => { cancelExport = true; });
  $('#share').addEventListener('click', share);
  $('#checkUpd').addEventListener('click', () => checkUpdate(true));
  $('#resetAll').addEventListener('click', () => { for (const c of CONTROLS) { state.ui[c.id] = c.def; c.sync(); } state.gauge = '16mm'; document.querySelectorAll('.gauge').forEach(x => x.classList.toggle('on', x.dataset.id === '16mm')); state.border = true; $('#border').checked = true; saveSettings(); requestPreview(); });
  window.addEventListener('resize', layoutCanvas);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); $('#warn').hidden = false; $('#warn').textContent = 'Graphics context lost — reload the page.'; });
  checkUpdate(false);
}
window.filmLab = { get film() { return film; }, params, state, openFile, runExport, get lastExport() { return lastExport; }, ready: () => !!borderImage && !!film?.lut };
boot().catch(e => { $('#warn').hidden = false; $('#warn').textContent = e.message; console.error(e); });
