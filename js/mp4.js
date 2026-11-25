// film-lab · minimal MOV/MP4 demuxer + MP4 muxer (no dependencies)
// Demux: reads sample tables for the first video + first audio track.
// Mux:   new encoded video track + original audio samples copied byte-for-byte.

const td = new TextDecoder('latin1');
const fourcc = (u8, o) => td.decode(u8.subarray(o, o + 4));

class Reader {
  constructor(buf, off = 0) { this.u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf); this.dv = new DataView(this.u8.buffer, this.u8.byteOffset, this.u8.byteLength); this.p = off; }
  u8_() { return this.dv.getUint8(this.p++); }
  u16() { const v = this.dv.getUint16(this.p); this.p += 2; return v; }
  u32() { const v = this.dv.getUint32(this.p); this.p += 4; return v; }
  i32() { const v = this.dv.getInt32(this.p); this.p += 4; return v; }
  u64() { const hi = this.u32(), lo = this.u32(); return hi * 4294967296 + lo; }
  i64() { const hi = this.i32(), lo = this.u32(); return hi * 4294967296 + lo; }
}

// iterate child boxes inside u8[start, end)
function* boxes(u8, start = 0, end = u8.length) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p), hs = 8;
    const type = fourcc(u8, p + 4);
    if (size === 1) { size = dv.getUint32(p + 8) * 4294967296 + dv.getUint32(p + 12); hs = 16; }
    else if (size === 0) size = end - p;
    if (size < hs || p + size > end) break;
    yield { type, start: p, hs, end: p + size, body: p + hs };
    p += size;
  }
}
const child = (u8, b, type) => { for (const c of boxes(u8, b.body, b.end)) if (c.type === type) return c; return null; };
const path = (u8, b, ...types) => { let cur = b; for (const t of types) { cur = cur && child(u8, cur, t); } return cur; };

async function readTopLevel(file) {
  const out = []; let p = 0;
  while (p + 8 <= file.size) {
    const h = new Uint8Array(await file.slice(p, p + 16).arrayBuffer());
    const dv = new DataView(h.buffer);
    let size = dv.getUint32(0), hs = 8; const type = fourcc(h, 4);
    if (size === 1) { size = dv.getUint32(8) * 4294967296 + dv.getUint32(12); hs = 16; }
    else if (size === 0) size = file.size - p;
    if (size < 8) break;
    out.push({ type, start: p, size, hs });
    p += size;
  }
  return out;
}

function parseTrak(u8, trak) {
  const t = {};
  const tkhd = child(u8, trak, 'tkhd');
  { const r = new Reader(u8, tkhd.body); const v = r.u8_(); r.p += 3; r.p += v ? 16 : 8; t.id = r.u32(); r.p += 4; r.p += v ? 8 : 4; r.p += 8 + 2 + 2 + 2 + 2;
    t.matrix = []; for (let i = 0; i < 9; i++) t.matrix.push(r.i32()); t.tkW = r.u32() / 65536; t.tkH = r.u32() / 65536; }
  const mdhd = path(u8, trak, 'mdia', 'mdhd');
  { const r = new Reader(u8, mdhd.body); const v = r.u8_(); r.p += 3; r.p += v ? 16 : 8; t.timescale = r.u32(); t.mediaDuration = v ? r.u64() : r.u32(); t.language = r.u16(); }
  const hdlr = path(u8, trak, 'mdia', 'hdlr'); t.handler = fourcc(u8, hdlr.body + 8);
  const elst = path(u8, trak, 'edts', 'elst');
  if (elst) { const r = new Reader(u8, elst.body); const v = r.u8_(); r.p += 3; const n = r.u32(); t.edits = [];
    for (let i = 0; i < n; i++) t.edits.push(v ? { dur: r.u64(), mediaTime: r.i64(), rate: r.u32() } : { dur: r.u32(), mediaTime: r.i32(), rate: r.u32() }); }
  const stbl = path(u8, trak, 'mdia', 'minf', 'stbl');
  const stsd = child(u8, stbl, 'stsd');
  const e0 = boxes(u8, stsd.body + 8, stsd.end).next().value;
  t.codecFourcc = e0.type; t.stsdEntry = u8.slice(e0.start, e0.end);
  // extra boxes to carry over for audio (roll groups)
  t.extraStbl = [];
  for (const c of boxes(u8, stbl.body, stbl.end)) if (c.type === 'sgpd' || c.type === 'sbgp') t.extraStbl.push(u8.slice(c.start, c.end));
  // --- sample tables
  const rd = (type) => { const b = child(u8, stbl, type); return b ? new Reader(u8, b.body + 4) : null; };
  const stts = rd('stts'), ctts = rd('ctts'), stsc = rd('stsc'), stss = rd('stss');
  let stsz = rd('stsz'); const stco = rd('stco'), co64 = rd('co64');
  const sizes = []; { const ss = stsz.u32(), n = stsz.u32(); for (let i = 0; i < n; i++) sizes.push(ss || stsz.u32()); }
  const n = sizes.length;
  const offsetsChunk = []; if (stco) { const c = stco.u32(); for (let i = 0; i < c; i++) offsetsChunk.push(stco.u32()); } else { const c = co64.u32(); for (let i = 0; i < c; i++) offsetsChunk.push(co64.u64()); }
  const stscE = []; { const c = stsc.u32(); for (let i = 0; i < c; i++) stscE.push([stsc.u32(), stsc.u32(), stsc.u32()]); }
  const samples = new Array(n);
  let si = 0;
  for (let e = 0; e < stscE.length; e++) {
    const [first, spc] = stscE[e]; const last = e + 1 < stscE.length ? stscE[e + 1][0] - 1 : offsetsChunk.length;
    for (let ch = first; ch <= last && si < n; ch++) { let off = offsetsChunk[ch - 1]; for (let k = 0; k < spc && si < n; k++) { samples[si] = { offset: off, size: sizes[si] }; off += sizes[si]; si++; } }
  }
  { let dts = 0, i = 0; const c = stts.u32(); for (let e = 0; e < c; e++) { const cnt = stts.u32(), d = stts.u32(); for (let k = 0; k < cnt && i < n; k++, i++) { samples[i].dts = dts; samples[i].duration = d; dts += d; } } }
  for (const s of samples) s.cts = s.dts;
  if (ctts) { const c = ctts.u32(); let i = 0; for (let e = 0; e < c; e++) { const cnt = ctts.u32(), o = ctts.i32(); for (let k = 0; k < cnt && i < n; k++, i++) samples[i].cts = samples[i].dts + o; } }
  if (stss) { for (const s of samples) s.sync = false; const c = stss.u32(); for (let e = 0; e < c; e++) { const k = stss.u32() - 1; if (samples[k]) samples[k].sync = true; } }
  else for (const s of samples) s.sync = true;
  t.samples = samples;
  // --- codec config
  const se = t.stsdEntry;
  if (t.handler === 'vide') {
    const r = new Reader(se, 8 + 6 + 2 + 16); t.width = r.u16(); t.height = r.u16();
    for (const c of boxes(se, 8 + 78, se.length)) {
      if (c.type === 'avcC') { t.description = se.slice(c.body, c.end); t.codec = 'avc1.' + [1, 2, 3].map(i => t.description[i].toString(16).padStart(2, '0')).join(''); }
      if (c.type === 'hvcC') { t.description = se.slice(c.body, c.end); t.codec = hevcCodecString(t.codecFourcc, t.description); }
    }
  } else if (t.handler === 'soun') {
    const r = new Reader(se, 8 + 8); const ver = r.u16(); r.p += 6; t.channels = r.u16(); t.sampleSize = r.u16(); r.p += 4; t.sampleRate = r.u32() / 65536;
    let childStart = 8 + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
    if (ver === 2) { const f =new DataView(se.buffer, se.byteOffset + 8 + 28 + 4, 8).getFloat64(0); t.sampleRate = f; t.channels = new DataView(se.buffer, se.byteOffset + 8 + 28 + 12, 4).getUint32(0); }
    t.esds = findBox(se, childStart, se.length, 'esds');
  }
  return t;
}
function findBox(u8, start, end, type) {
  for (const c of boxes(u8, start, end)) {
    if (c.type === type) return u8.slice(c.start, c.end);
    if (c.type === 'wave') { const f = findBox(u8, c.body, c.end, type); if (f) return f; }
  }
  return null;
}
function hevcCodecString(fcc, h) {
  const space = h[1] >> 6, tier = (h[1] >> 5) & 1, prof = h[1] & 31;
  let compat = (h[2] << 24 | h[3] << 16 | h[4] << 8 | h[5]) >>> 0; let rev = 0; for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; } rev >>>= 0;
  const cons = [6, 7, 8, 9, 10, 11].map(i => h[i]); while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  return `${fcc}.${['', 'A', 'B', 'C'][space]}${prof}.${rev.toString(16)}.${tier ? 'H' : 'L'}${h[12]}${cons.length ? '.' + cons.map(c => c.toString(16)).join('.') : ''}`;
}

export async function demux(file) {
  const top = await readTopLevel(file);
  const m = top.find(b => b.type === 'moov'); if (!m) throw new Error('No moov box — not a MOV/MP4 file?');
  const u8 = new Uint8Array(await file.slice(m.start, m.start + m.size).arrayBuffer());
  const moov = { type: 'moov', start: 0, body: m.hs, end: u8.length };
  const mvhd = child(u8, moov, 'mvhd'); const r = new Reader(u8, mvhd.body); const v = r.u8_(); r.p += 3;
  const movie = { creation: v ? r.u64() : r.u32(), modification: v ? r.u64() : r.u32(), timescale: r.u32(), duration: v ? r.u64() : r.u32() };
  const tracks = []; for (const b of boxes(u8, moov.body, moov.end)) if (b.type === 'trak') { try { tracks.push(parseTrak(u8, b)); } catch (e) { console.warn('trak skipped', e); } }
  const meta = []; for (const b of boxes(u8, moov.body, moov.end)) if (b.type === 'meta' || b.type === 'udta') meta.push(u8.slice(b.start, b.end));
  const video = tracks.find(t => t.handler === 'vide' && t.codec);
  const audio = tracks.find(t => t.handler === 'soun' && t.codecFourcc === 'mp4a' && t.esds);
  if (!video) throw new Error('No H.264/HEVC video track found');
  // rotation from matrix (a,b,c,d)
  const [a, b, , c, d] = video.matrix; const deg = Math.round(Math.atan2(b, a) * 180 / Math.PI);
  video.rotation = ((deg % 360) + 360) % 360;
  const durS = video.samples.reduce((s, x) => s + x.duration, 0) / video.timescale;
  video.fps = video.samples.length / durS;
  return { file, movie, video, audio, meta, otherAudio: tracks.filter(t => t.handler === 'soun' && t !== audio).length };
}

// --------------------------------------------------------------------------- mux
const enc = new TextEncoder();
function box(type, ...parts) {
  let len = 8; for (const p of parts) len += p.length;
  const out = new Uint8Array(len); const dv = new DataView(out.buffer); dv.setUint32(0, len); out.set(enc.encode(type), 4);
  let o = 8; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}
function bytes(n) { return new Uint8Array(n); }
class W {
  constructor() { this.a = []; }
  u8(v) { this.a.push(v & 255); return this; }
  u16(v) { this.a.push((v >> 8) & 255, v & 255); return this; }
  u24(v) { this.a.push((v >> 16) & 255, (v >> 8) & 255, v & 255); return this; }
  u32(v) { v = v >>> 0; this.a.push((v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255); return this; }
  i32(v) { return this.u32(v | 0); }
  u64(v) { const hi = Math.floor(v / 4294967296), lo = v % 4294967296; return this.u32(hi).u32(lo); }
  str(s) { for (const ch of enc.encode(s)) this.a.push(ch); return this; }
  raw(u8) { for (const b of u8) this.a.push(b); return this; }
  get b() { return new Uint8Array(this.a); }
}
const full = (type, ver, flags, body) => box(type, new W().u8(ver).u24(flags).b, body);

function stbl(sampleEntry, s, extra = []) {
  // s: {durations[], sizes[], chunkOffsets[] (one chunk), sync[] (null = all), cttsOffsets[] (null)}
  const n = s.sizes.length;
  const stsd = full('stsd', 0, 0, new W().u32(1).raw(sampleEntry).b);
  const tt = []; for (const d of s.durations) { if (tt.length && tt[tt.length - 1][1] === d) tt[tt.length - 1][0]++; else tt.push([1, d]); }
  const w = new W().u32(tt.length); for (const [c, d] of tt) w.u32(c).u32(d);
  const parts = [stsd, full('stts', 0, 0, w.b)];
  if (s.cttsOffsets && s.cttsOffsets.some(x => x !== 0)) {
    const ct = []; for (const o of s.cttsOffsets) { if (ct.length && ct[ct.length - 1][1] === o) ct[ct.length - 1][0]++; else ct.push([1, o]); }
    const cw = new W().u32(ct.length); for (const [c, o] of ct) cw.u32(c).i32(o); parts.push(full('ctts', 1, 0, cw.b));
  }
  if (s.sync) { const idx = []; s.sync.forEach((k, i) => k && idx.push(i + 1)); if (idx.length !== n) { const sw = new W().u32(idx.length); idx.forEach(i => sw.u32(i)); parts.push(full('stss', 0, 0, sw.b)); } }
  for (const e of extra) parts.push(e);
  parts.push(full('stsc', 0, 0, new W().u32(1).u32(1).u32(n).u32(1).b));
  const zw = new W().u32(0).u32(n); for (const z of s.sizes) zw.u32(z); parts.push(full('stsz', 0, 0, zw.b));
  const off = s.chunkOffset;
  parts.push(off > 0xffffffff ? full('co64', 0, 0, new W().u32(1).u64(off).b) : full('stco', 0, 0, new W().u32(1).u32(off).b));
  return box('stbl', ...parts);
}
function trak({ id, handler, timescale, mediaDuration, movieDuration, matrix, width, height, language, edits, minfHeader, stblBox, volume }) {
  const tk = new W().u32(0).u32(0).u32(id).u32(0).u32(movieDuration).u32(0).u32(0).u16(0).u16(0).u16(volume ? 0x0100 : 0).u16(0);
  for (const m of matrix) tk.i32(m); tk.u32(Math.round(width * 65536)).u32(Math.round(height * 65536));
  const parts = [full('tkhd', 0, 3, tk.b)];
  if (edits && edits.length) { const ew = new W().u32(edits.length); for (const e of edits) ew.u32(e.dur).i32(e.mediaTime).u32(e.rate); parts.push(box('edts', full('elst', 0, 0, ew.b))); }
  const mdhd = full('mdhd', 0, 0, new W().u32(0).u32(0).u32(timescale).u32(mediaDuration).u16(language ?? 0x55c4).u16(0).b);
  const name = handler === 'vide' ? 'film-lab video' : 'Core Media Audio';
  const hdlr = full('hdlr', 0, 0, new W().u32(0).str(handler).u32(0).u32(0).u32(0).str(name).u8(0).b);
  const dinf = box('dinf', full('dref', 0, 0, new W().u32(1).raw(full('url ', 0, 1, bytes(0))).b));
  parts.push(box('mdia', mdhd, hdlr, box('minf', minfHeader, dinf, stblBox)));
  return box('trak', ...parts);
}
function avcEntry(fcc, width, height, configBox, cl = { prim: 1, trc: 1, mat: 1, full: 0 }) {
  const w = new W().raw(bytes(6)).u16(1).u16(0).u16(0).u32(0).u32(0).u32(0).u16(width).u16(height).u32(0x00480000).u32(0x00480000).u32(0).u16(1);
  const name = 'film-lab'; w.u8(name.length).str(name).raw(bytes(31 - name.length)).u16(0x18).u16(0xffff);
  const colr = box('colr', new W().str('nclx').u16(cl.prim).u16(cl.trc).u16(cl.mat).u8(cl.full ? 0x80 : 0).b);
  const pasp = box('pasp', new W().u32(1).u32(1).b);
  return box(fcc, w.b, configBox, colr, pasp);
}
function mp4aEntry(a) {
  const w = new W().raw(bytes(6)).u16(1).u32(0).u32(0).u16(a.channels).u16(16).u16(0).u16(0).u32(Math.min(65535, Math.round(a.sampleRate)) * 65536);
  return box('mp4a', w.b, a.esds);
}

// chunks: [{data:Uint8Array, timestamp(µs), key}] in decode order; ptsTicks: Map µs->ticks
export function mux({ src, chunks, videoConfig, fcc }) {
  const v = src.video, a = src.audio, ts = v.timescale;
  // presentation times in source ticks (sorted) — output keeps source timing exactly
  const srcPts = v.samples.map(s => s.cts).sort((x, y) => x - y);
  const usToTick = new Map(); const srcDur = new Map();
  const byCts = [...v.samples].sort((x, y) => x.cts - y.cts);
  byCts.forEach(s => { usToTick.set(Math.round(s.cts * 1e6 / ts), s.cts); srcDur.set(s.cts, s.duration); });
  const tickOf = (us) => { if (usToTick.has(us)) return usToTick.get(us); return Math.round(us * ts / 1e6); };
  const pts = chunks.map(c => tickOf(c.timestamp));
  const sortedPts = [...pts].sort((x, y) => x - y);
  // decode times: sorted pts shifted so dts <= pts
  let shift = 0; pts.forEach((p, i) => { shift = Math.max(shift, sortedPts[i] - p); });
  const dts = sortedPts.map(p => p - shift);
  const base = dts[0];
  const cttsOffsets = pts.map((p, i) => p - dts[i]);
  const durations = dts.map((d, i) => i + 1 < dts.length ? dts[i + 1] - d : (srcDur.get(sortedPts[i]) ?? Math.round(ts / v.fps)));
  const vMediaDur = durations.reduce((s, x) => s + x, 0);
  // edits: keep source edit list but shift media time by ctts delay
  const mts = src.movie.timescale;
  const vEdits = (v.edits && v.edits.length ? v.edits : [{ dur: Math.round(vMediaDur * mts / ts), mediaTime: 0, rate: 0x10000 }])
    .map(e => ({ ...e, mediaTime: e.mediaTime >= 0 ? Math.max(0, e.mediaTime - base) : e.mediaTime }));
  // ---- layout: ftyp | mdat(video..., audio...) | moov
  const ftyp = box('ftyp', new W().str('isom').u32(0x200).str('isom').str('iso2').str('avc1').str('mp41').b);
  let desc = videoConfig.description, colr;
  if (fcc === 'avc1') { try { const fx = fixAvcColour(desc); desc = fx.avcC; colr = fx.colr; for (const c of chunks) if (c.key) c.data = fx.fixChunk(c.data); } catch (e) { console.warn('SPS colour retag skipped', e); } }
  let videoBytes = 0; for (const c of chunks) videoBytes += c.data.length;
  const aSamples = a ? a.samples : [];
  let audioBytes = 0; for (const s of aSamples) audioBytes += s.size;
  const mdatHeader = new W().u32(1).str('mdat').u64(16 + videoBytes + audioBytes).b;
  const vOffset = ftyp.length + 16, aOffset = vOffset + videoBytes;
  const configBox = box(fcc === 'avc1' ? 'avcC' : 'hvcC', desc);
  const vStbl = stbl(avcEntry(fcc, videoConfig.width, videoConfig.height, configBox, colr),
    { durations, sizes: chunks.map(c => c.data.length), chunkOffset: vOffset, sync: chunks.map(c => c.key), cttsOffsets });
  const movieDurV = vEdits.reduce((s, e) => s + e.dur, 0);
  const tracks = [trak({ id: 1, handler: 'vide', timescale: ts, mediaDuration: vMediaDur, movieDuration: movieDurV, matrix: v.matrix, width: v.tkW || videoConfig.width, height: v.tkH || videoConfig.height,
    language: v.language, edits: vEdits, minfHeader: full('vmhd', 0, 1, bytes(8)), stblBox: vStbl })];
  let movieDur = movieDurV;
  if (a) {
    const aMediaDur = aSamples.reduce((s, x) => s + x.duration, 0);
    const aEdits = a.edits && a.edits.length ? a.edits : [{ dur: Math.round(aMediaDur * mts / a.timescale), mediaTime: 0, rate: 0x10000 }];
    const aStbl = stbl(mp4aEntry(a), { durations: aSamples.map(s => s.duration), sizes: aSamples.map(s => s.size), chunkOffset: aOffset, sync: null, cttsOffsets: null }, a.extraStbl);
    const md = aEdits.reduce((s, e) => s + e.dur, 0); movieDur = Math.max(movieDur, md);
    tracks.push(trak({ id: 2, handler: 'soun', timescale: a.timescale, mediaDuration: aMediaDur, movieDuration: md, matrix: [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000], width: 0, height: 0,
      language: a.language, edits: aEdits, minfHeader: full('smhd', 0, 0, bytes(4)), stblBox: aStbl, volume: true }));
  }
  const mv = new W().u32(src.movie.creation).u32(src.movie.modification).u32(mts).u32(movieDur).u32(0x10000).u16(0x100).raw(bytes(10));
  for (const m of [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]) mv.i32(m); mv.raw(bytes(24)).u32(tracks.length + 1);
  const moov = box('moov', full('mvhd', 0, 0, mv.b), ...tracks, ...src.meta);
  // Blob parts: video chunk bytes + lazy slices of the source file for audio (no re-encode, no copy in memory)
  const parts = [ftyp, mdatHeader]; for (const c of chunks) parts.push(c.data);
  for (const s of aSamples) parts.push(src.file.slice(s.offset, s.offset + s.size));
  parts.push(moov);
  const blob = new Blob(parts, { type: 'video/mp4' }); blob.colr = colr; return blob;
}


// ---- H.264 SPS colour handling: report real range/matrix and retag transfer+primaries as BT.709
function unescapeRbsp(n) { const o = []; let z = 0; for (const b of n) { if (z >= 2 && b === 3) { z = 0; continue; } o.push(b); z = b === 0 ? z + 1 : 0; } return new Uint8Array(o); }
function escapeRbsp(r, hdrLen = 1) { const o = []; let z = 0; r.forEach((b, i) => { if (i >= hdrLen && z >= 2 && b <= 3) { o.push(3); z = 0; } o.push(b); z = b === 0 ? z + 1 : 0; }); return new Uint8Array(o); }
class Bits {
  constructor(u8) { this.u8 = u8; this.p = 0; }
  u(n) { let v = 0; for (let i = 0; i < n; i++) { v = v * 2 + ((this.u8[this.p >> 3] >> (7 - (this.p & 7))) & 1); this.p++; } return v; }
  ue() { let z = 0; while (this.u(1) === 0 && z < 32) z++; return z ? (2 ** z - 1 + this.u(z)) : 0; }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -k / 2; }
}
export function spsColour(nal) {
  const r = unescapeRbsp(nal), b = new Bits(r); b.p = 8;
  const profile = b.u(8); b.u(16); b.ue();
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    const cf = b.ue(); if (cf === 3) b.u(1); b.ue(); b.ue(); b.u(1);
    if (b.u(1)) for (let i = 0; i < (cf !== 3 ? 8 : 12); i++) if (b.u(1)) { const size = i < 6 ? 16 : 64; let last = 8, next = 8; for (let j = 0; j < size; j++) { if (next !== 0) next = (last + b.se() + 256) % 256; last = next === 0 ? last : next; } }
  }
  b.ue(); const poc = b.ue(); if (poc === 0) b.ue(); else if (poc === 1) { b.u(1); b.se(); b.se(); const n = b.ue(); for (let i = 0; i < n; i++) b.se(); }
  b.ue(); b.u(1); b.ue(); b.ue(); if (!b.u(1)) b.u(1); b.u(1);
  if (b.u(1)) { b.ue(); b.ue(); b.ue(); b.ue(); }
  const res = { rbsp: r };
  if (!b.u(1)) return res;
  if (b.u(1)) { if (b.u(8) === 255) b.u(32); }
  if (b.u(1)) b.u(1);
  if (!b.u(1)) return res;
  b.u(3); res.full = b.u(1);
  if (!b.u(1)) return res;
  res.pos = b.p; res.prim = b.u(8); res.trc = b.u(8); res.mat = b.u(8);
  return res;
}
function retagSps(nal) {
  const c = spsColour(nal); if (c.pos == null) return { nal, c };
  const r = c.rbsp.slice(); const setByte = (bitPos, v) => { for (let i = 0; i < 8; i++) { const p = bitPos + i, m = 1 << (7 - (p & 7)); if ((v >> (7 - i)) & 1) r[p >> 3] |= m; else r[p >> 3] &= ~m; } };
  setByte(c.pos, 1); setByte(c.pos + 8, 1);
  return { nal: escapeRbsp(r), c };
}
// returns {avcC, colr:{prim,trc,mat,full}, fixChunk(u8)->u8}
export function fixAvcColour(avcC) {
  const d = avcC; let p = 5; const nS = d[p++] & 31; const sps = []; for (let i = 0; i < nS; i++) { const l = d[p] << 8 | d[p + 1]; sps.push(d.subarray(p + 2, p + 2 + l)); p += 2 + l; }
  const rest = d.subarray(p);
  let info = { prim: 1, trc: 1, mat: 1, full: 0 };
  const fixed = sps.map(n => { const { nal, c } = retagSps(n); if (c.full != null) info.full = c.full; if (c.mat != null && c.mat !== 2) info.mat = c.mat; return nal; });
  const w = new W().raw(d.subarray(0, 5)).u8(0xe0 | fixed.length); for (const n of fixed) w.u16(n.length).raw(n); w.raw(rest);
  const fixChunk = (u8) => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); const nals = []; let o = 0, has = false;
    while (o + 4 <= u8.length) { const l = dv.getUint32(o); const n = u8.subarray(o + 4, o + 4 + l); if ((n[0] & 31) === 7) { has = true; nals.push(retagSps(n).nal); } else nals.push(n); o += 4 + l; }
    if (!has) return u8; let len = 0; for (const n of nals) len += 4 + n.length; const out = new Uint8Array(len); const ov = new DataView(out.buffer); o = 0;
    for (const n of nals) { ov.setUint32(o, n.length); out.set(n, o + 4); o += 4 + n.length; } return out;
  };
  return { avcC: w.b, colr: info, fixChunk };
}

// Annex-B → AVCC helpers (in case the encoder emits start codes)
export function annexBToAvcc(u8) {
  const nals = splitAnnexB(u8); let len = 0; for (const n of nals) len += 4 + n.length;
  const out = new Uint8Array(len); const dv = new DataView(out.buffer); let o = 0;
  for (const n of nals) { dv.setUint32(o, n.length); out.set(n, o + 4); o += 4 + n.length; } return { data: out, nals };
}
export function splitAnnexB(u8) {
  const out = []; let i = 0, start = -1;
  while (i + 3 <= u8.length) {
    if (u8[i] === 0 && u8[i + 1] === 0 && (u8[i + 2] === 1 || (u8[i + 2] === 0 && u8[i + 3] === 1))) {
      if (start >= 0) out.push(u8.subarray(start, i));
      i += u8[i + 2] === 1 ? 3 : 4; start = i;
    } else i++;
  }
  if (start >= 0) out.push(u8.subarray(start)); return out.map(n => { let e = n.length; while (e > 0 && n[e - 1] === 0) e--; return n.subarray(0, e); });
}
export function avcCFromNals(nals) {
  const sps = nals.filter(n => (n[0] & 31) === 7), pps = nals.filter(n => (n[0] & 31) === 8);
  if (!sps.length || !pps.length) return null;
  const w = new W().u8(1).u8(sps[0][1]).u8(sps[0][2]).u8(sps[0][3]).u8(0xff).u8(0xe0 | sps.length);
  for (const s of sps) w.u16(s.length).raw(s); w.u8(pps.length); for (const p of pps) w.u16(p.length).raw(p);
  return w.b;
}
