// GRYT-1432's gate: one sender, two viewers. One draws the share full screen, one is hidden; then
// both hidden for 30 s; then one back. `node gate.mjs <label> <old|new>` against BW_SFU.
import { startSfu, startStatic, startChrome, newGuest, joinOpts, sleep, writeResult } from './lib.mjs';
const here = new URL('.', import.meta.url).pathname;
const label = process.argv[2] || 'gate', client = process.argv[3] || 'new';
const fresh = client === 'new';
await startSfu(here + `sfu-${label}.log`); startStatic(); const chrome = await startChrome();
const snd = await newGuest(chrome, 'sender'), a = await newGuest(chrome, 'a'), b = await newGuest(chrome, 'b');
await snd.ev(`H.join(${joinOpts('alice', { mic: true, engine: fresh, camera: { w: 1920, h: 1080, fps: 30, synthetic: true }, screen: { w: 1920, h: 1080, fps: 30, content: 'text' } })})`);
await sleep(1000);
for (const [g, u] of [[a, 'bob'], [b, 'carol']]) await g.ev(`H.join(${joinOpts(u, { demand: fresh, viewW: 320, viewH: 180 })})`);
await sleep(4000);
const streams = await snd.ev('H.streams');
const ids = await a.ev(`H.trackIds(${JSON.stringify(streams)})`);
if (!ids.camera || !ids.screen) throw new Error(`viewer is missing a track: ${JSON.stringify(ids)}`);
const show = (g, on) => g.ev(`(H.report(${JSON.stringify(streams.screen)}, ${on ? 1920 : 0}, ${on ? 1080 : 0}, 60), H.report(${JSON.stringify(streams.camera)}, ${on ? 320 : 0}, ${on ? 180 : 0}, 60))`);

const snaps = { snd: [], a: [], b: [] };
const snapAll = async () => { const t = Date.now(); for (const [k, g] of [['snd', snd], ['a', a], ['b', b]]) snaps[k].push({ t, ...(await g.ev('H.snap()')) }); };
const at = (k, t) => snaps[k].reduce((best, s) => (Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best));
const bytes = (s, dir, n) => { const x = s[dir][n]; return x ? x.bytes + x.hdr : 0; };
function windowStats(t0, t1) {
  const s0 = at('snd', t0), s1 = at('snd', t1), secs = (s1.t - s0.t) / 1000;
  const out = {};
  for (const n of ['camera', 'screen']) {
    const x = s1.out[n];
    out[n] = { size: x.active === false || s1.out[n].fe === s0.out[n].fe ? 'paused' : `${x.w}x${x.h}`, kbps: Math.round((bytes(s1, 'out', n) - bytes(s0, 'out', n)) * 8 / secs / 1000), fps: Math.round((x.fe - s0.out[n].fe) / secs) };
  }
  const recv = (k) => { const r0 = at(k, t0), r1 = at(k, t1); let sum = 0; for (const id of Object.keys(r1.in)) sum += bytes(r1, 'in', id) - bytes(r0, 'in', id); return Math.round(sum * 8 / secs / 1000); };
  out.upKbps = Math.round((s1.pair.sent - s0.pair.sent) * 8 / secs / 1000);
  out.aRecvKbps = recv('a'); out.bRecvKbps = recv('b');
  return out;
}
const sampler = setInterval(() => { snapAll().catch(() => {}); }, 1000);
await snapAll();

// Phase 1: A full screen, B hidden.
await show(a, true); await show(b, false);
const p1 = Date.now(); await sleep(30_000);
// Phase 2: both hidden.
await show(a, false);
const p2 = Date.now(); await sleep(30_000);
// Phase 3: A back.
await a.ev('H.takeFrames()');
const aBefore = await a.ev('H.snap()');
const p3 = Date.now(); await show(a, true);
await sleep(20_000);
const p3end = Date.now();
clearInterval(sampler); await snapAll();
const frames = await a.ev('H.takeFrames()');
const aAfter = await a.ev('H.snap()');

const resume = {};
for (const [n, id] of Object.entries(ids)) {
  const f = (frames[id] || []).filter(([t]) => t >= p3);
  let gap = 0; for (let i = 1; i < f.length; i++) gap = Math.max(gap, f[i][0] - f[i - 1][0]);
  const inA = aAfter.in[id], inB = aBefore.in[id];
  resume[n] = {
    firstFrameMs: f.length ? Math.round(f[0][0] - p3) : null,
    firstSize: f.length ? `${f[0][1]}x${f[0][2]}` : null,
    longestGapAfterMs: Math.round(gap),
    freezes: inA && inB ? inA.freeze - inB.freeze : null,
    freezeS: inA && inB ? +(inA.freezeDur - inB.freezeDur).toFixed(2) : null,
  };
}
const result = {
  label, client, sfu: (process.env.BW_SFU || 'sfu-main').split('/').pop(), chrome: chrome.version, chromeArgs: process.env.BW_CHROME_ARGS || '',
  oneFullOneHidden: windowStats(p1 + 15_000, p2),
  bothHidden: windowStats(p2 + 15_000, p3),
  oneBack: windowStats(p3 + 5_000, p3end),
  resume,
  wanted: (await snd.ev('H.events')).filter(([, s]) => s.startsWith('video_wanted')).map(([t, s]) => [t - p1, s]),
};
console.log(JSON.stringify(result, null, 1));
writeResult(`gate-${label}`, result);
process.exit(0);
