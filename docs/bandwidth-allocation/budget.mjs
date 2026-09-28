// Stage 2's gate: estimate.mjs's uplink steps with the engine's controller on the sender and a
// viewer drawing the share full size. `node budget.mjs <label> [old|new]`, BW_CAM_VIEW=640x360.
// BW_START_MBPS=0.8 shapes the link before anyone joins, so the call starts thin (GRYT-1571).
import { startSfu, startStatic, startRelay, startChrome, newGuest, joinOpts, sleep, CFG, writeResult } from './lib.mjs';
const here = new URL('.', import.meta.url).pathname;
const label = process.argv[2] || 'budget', client = process.argv[3] || 'new';
const fresh = client === 'new';
const [camW, camH] = (process.env.BW_CAM_VIEW || '640x360').split('x').map(Number);
const report = process.env.BW_REPORT !== '0';
const screenOpts = { w: 1920, h: 1080, fps: 30, content: process.env.BW_CONTENT || 'text', priority: process.env.BW_SCREEN_PRIORITY };
await startSfu(here + `sfu-${label}.log`); startStatic(); const relay = startRelay(); const chrome = await startChrome();
if (process.env.BW_START_MBPS) relay.set({ rate: +process.env.BW_START_MBPS * 1e6 });
const snd = await newGuest(chrome, 'sender'); const v1 = await newGuest(chrome, 'viewer1');
await snd.ev(`H.join(${joinOpts('alice', { relayPort: CFG.relayPort, mic: true, engine: fresh, camera: { w: 1280, h: 720, fps: 30, synthetic: true }, screen: screenOpts })})`);
const tJoin = Date.now();
await snd.ev('H.startSampling(200)');
await sleep(1500);
await v1.ev(`H.join(${joinOpts('bob', { viewW: 1920, viewH: 1080, demand: fresh && report })})`);
const views = [];
const relayAt = () => ({ in: relay.stats.inBytes, out: relay.stats.outBytes, drop: relay.stats.droppedBytes });
const viewSampler = setInterval(async () => { try { views.push({ t: Date.now(), relay: relayAt(), ...(await v1.ev('H.snap()')) }); } catch {} }, 1000);
await sleep(3000);
const streams = await snd.ev('H.streams');
// A thin start can hold a track back until its first packets reach the SFU, so wait a while for it.
let ids = {};
for (let i = 0; i < 40; i++) { ids = await v1.ev(`H.trackIds(${JSON.stringify(streams)})`); if (ids.camera && ids.screen) break; await sleep(500); }
if (!ids.camera || !ids.screen) console.error(`viewer is missing a track: ${JSON.stringify(ids)}`);
if (fresh && report) await v1.ev(`(H.report(${JSON.stringify(streams.screen)}, 1920, 1080, 60), H.report(${JSON.stringify(streams.camera)}, ${camW}, ${camH}, 60))`);

const plan = (process.env.BW_PLAN || '0:1000,40:2,70:1000,100:0.8,130:1000,170:end').split(',').map(s => { const [t, r] = s.split(':'); return { t: +t, rate: r }; });
const t0 = Date.now(); const marks = [];
for (const p of plan) {
  const wait = t0 + p.t * 1000 - Date.now(); if (wait > 0) await sleep(wait);
  if (p.rate === 'end') { marks.push({ t: Date.now(), end: true }); break; }
  relay.set({ rate: +p.rate * 1e6 }); marks.push({ t: Date.now(), mbps: +p.rate });
  console.error('rate', p.rate, 'Mbps at', Math.round((Date.now() - t0) / 1000), 's');
}
clearInterval(viewSampler);
await snd.ev('H.stopSampling()');
const samples = await snd.ev('H.take()');
const events = (await snd.ev('H.events')).filter(([t]) => t >= t0).map(([t, s]) => [+((t - t0) / 1000).toFixed(1), s]);

// One-second windows on the sender: rate, size and frame rate per stream, plus the estimate.
const secs = [];
for (let i = 5; i < samples.length; i += 5) {
  const a = samples[i - 5], b = samples[i]; const dt = (b.t - a.t) / 1000;
  const row = { s: +((b.t - t0) / 1000).toFixed(1), aob: b.pair?.aob ? Math.round(b.pair.aob / 1000) : null };
  for (const n of ['camera', 'screen', 'mic']) {
    const x = b.out[n], y = a.out[n]; if (!x || !y) continue;
    row[n] = { kbps: Math.round(((x.bytes + x.hdr) - (y.bytes + y.hdr)) * 8 / dt / 1000), size: `${x.w}x${x.h}`, fps: Math.round((x.fe - y.fe) / dt), qlr: x.qlr, tgt: x.tgt ? Math.round(x.tgt / 1000) : null, kf: (x.kf ?? 0) - (y.kf ?? 0), pli: (x.pli ?? 0) - (y.pli ?? 0), fir: (x.fir ?? 0) - (y.fir ?? 0), rtxKbps: Math.round(((x.rtx ?? 0) - (y.rtx ?? 0)) * 8 / dt / 1000), huge: (x.hugeFrames ?? 0) - (y.hugeFrames ?? 0), qp: x.fe > y.fe ? Math.round((x.qp - y.qp) / (x.fe - y.fe)) : null };
  }
  secs.push(row);
}
const mode = (xs) => { const c = {}; for (const x of xs) c[x] = (c[x] || 0) + 1; return Object.entries(c).sort((p, q) => q[1] - p[1])[0]?.[0]; };
const avg = (xs) => xs.length ? Math.round(xs.reduce((p, q) => p + q, 0) / xs.length) : null;
const phases = [];
for (let i = 0; i < marks.length - 1; i++) {
  const m = marks[i], s0 = (m.t - t0) / 1000, s1 = (marks[i + 1].t - t0) / 1000;
  const win = secs.filter(x => x.s > s0 && x.s <= s1);
  const tail = win.filter(x => x.s > s1 - 10);
  const per = {};
  for (const n of ['camera', 'screen']) {
    const rows = tail.map(x => x[n]).filter(Boolean);
    per[n] = { size: mode(rows.map(r => r.size)), kbps: avg(rows.map(r => r.kbps)), fps: avg(rows.map(r => r.fps)) };
  }
  // Settled: the last second either stream's sent size changed, and when the video rate stays in the link.
  let lastSizeChange = null;
  for (let j = 1; j < win.length; j++) for (const n of ['camera', 'screen']) if (win[j][n]?.size !== win[j - 1][n]?.size) lastSizeChange = win[j].s;
  const video = (x) => (x.camera?.kbps || 0) + (x.screen?.kbps || 0) + (x.mic?.kbps || 0);
  const link = m.mbps * 1000;
  let fitsFrom = null;
  if (link < 100_000) { for (let j = win.length - 1; j >= 0 && video(win[j]) <= link * 1.05; j--) fitsFrom = win[j].s; }
  const under = win.find(x => x.aob && x.aob <= link);
  const v0 = views.filter(v => v.t <= m.t).at(-1), v1s = views.filter(v => v.t <= marks[i + 1].t).at(-1);
  const fz = (id) => (id && v0 && v1s && v0.in[id] && v1s.in[id]) ? { freezes: v1s.in[id].freeze - v0.in[id].freeze, freezeS: +(v1s.in[id].freezeDur - v0.in[id].freezeDur).toFixed(2), recvFps: Math.round((v1s.in[id].fd - v0.in[id].fd) / ((v1s.t - v0.t) / 1000)), size: `${v1s.in[id].w}x${v1s.in[id].h}` } : null;
  phases.push({
    at: +s0.toFixed(1), mbps: m.mbps, ...per,
    aobSettled: avg(tail.map(x => x.aob).filter(Boolean)),
    aobUnderCapS: link < 100_000 && under ? +(under.s - s0).toFixed(1) : null,
    lastSizeChangeS: lastSizeChange === null ? null : +(lastSizeChange - s0).toFixed(1),
    rateFitsFromS: fitsFrom === null ? null : +(fitsFrom - s0).toFixed(1),
    viewerScreen: fz(ids.screen), viewerCamera: fz(ids.camera),
  });
}
const vEnd = views.at(-1), vStart = views.find((v) => v.t >= t0) ?? views[0];
const total = (id) => (id && vEnd.in[id] && vStart.in[id]) ? vEnd.in[id].freeze - vStart.in[id].freeze : null;
// The viewer's first decoded frame of each stream, in seconds from the sender's join.
const first = (id) => { const v = id && views.find((x) => x.in[id]?.fd > 0); return v ? +((v.t - tJoin) / 1000).toFixed(1) : null; };
const decoded = (id) => (id && vEnd.in[id]) ? vEnd.in[id].fd : 0;
const firstFrame = { screen: first(ids.screen), camera: first(ids.camera) }, framesDecoded = { screen: decoded(ids.screen), camera: decoded(ids.camera) };
const result = { label, client, sfu: (process.env.BW_SFU || 'sfu-main').split('/').pop(), dist: process.env.BW_VOICE_DIST || '../../dist', camView: report && fresh ? `${camW}x${camH}` : 'none', screen: screenOpts, chrome: chrome.version,
  startMbps: process.env.BW_START_MBPS ? +process.env.BW_START_MBPS : null, joinedS: +((tJoin - t0) / 1000).toFixed(1),
  freezesTotal: { screen: total(ids.screen), camera: total(ids.camera) }, firstFrame, framesDecoded, phases, relay: relay.stats, secs,
  viewer: views.map((v) => ({ s: +((v.t - t0) / 1000).toFixed(1), relay: v.relay, screen: v.in[ids.screen] && { fz: v.in[ids.screen].freeze, fd: v.in[ids.screen].fd, fr: v.in[ids.screen].fr, kf: v.in[ids.screen].kf, bytes: v.in[ids.screen].bytes, lost: v.in[ids.screen].lost, pli: v.in[ids.screen].pli, fir: v.in[ids.screen].fir, nack: v.in[ids.screen].nack }, camera: v.in[ids.camera] && { fz: v.in[ids.camera].freeze, fd: v.in[ids.camera].fd, fr: v.in[ids.camera].fr, pli: v.in[ids.camera].pli } })), events: events.filter(([, s]) => !s.startsWith('ontrack')) };
// ICE now and then finds a path past the relay, and then nothing was shaped.
if (relay.stats.inBytes < 1e6) { console.error('the sender never went through the relay; run it again'); process.exit(2); }
console.log(JSON.stringify({ label, firstFrame, framesDecoded, freezesTotal: result.freezesTotal, phases }, null, 1));
writeResult(`budget-${label}`, result);
process.exit(0);
