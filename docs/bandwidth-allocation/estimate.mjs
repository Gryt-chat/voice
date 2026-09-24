// How availableOutgoingBitrate follows the sender's uplink as the relay's rate changes.
// Plan as `seconds:Mbps,...` in BW_PLAN. `node estimate.mjs`
import { startSfu, startStatic, startRelay, startChrome, newGuest, joinOpts, sleep, CFG, writeResult } from './lib.mjs';
const here = new URL('.', import.meta.url).pathname;
await startSfu(here + 'sfu-estimate.log'); startStatic(); const relay = startRelay(); const chrome = await startChrome();
const snd = await newGuest(chrome, 'sender'); const v1 = await newGuest(chrome, 'viewer1');
await snd.ev(`H.join(${joinOpts('alice', { relayPort: CFG.relayPort, mic: true, camera: { w: 1280, h: 720, fps: 30, synthetic: true }, screen: { w: 1920, h: 1080, fps: 30, content: 'text' } })})`);
await sleep(1500);
await v1.ev(`H.join(${joinOpts('bob', { viewW: 1920, viewH: 1080 })})`);
const plan = (process.env.BW_PLAN || '0:1000,40:2,70:1000,100:0.8,130:1000,170:end').split(',').map(s => { const [t, r] = s.split(':'); return { t: +t, rate: r }; });
await snd.ev('H.startSampling(200)');
const t0 = Date.now(); const marks = [];
for (const p of plan) {
  const wait = t0 + p.t * 1000 - Date.now(); if (wait > 0) await sleep(wait);
  if (p.rate === 'end') break;
  relay.set({ rate: +p.rate * 1e6 }); marks.push({ t: Date.now(), mbps: +p.rate });
  console.log('rate', p.rate, 'Mbps at', Math.round((Date.now() - t0) / 1000), 's');
}
await snd.ev('H.stopSampling()');
const samples = await snd.ev('H.take()');
const series = samples.map((s, i) => {
  const p = samples[i - 1]; const dt = p ? (s.t - p.t) / 1000 : null;
  const k = (n) => p && s.out[n] && p.out[n] ? Math.round(((s.out[n].bytes + s.out[n].hdr) - (p.out[n].bytes + p.out[n].hdr)) * 8 / dt / 1000) : null;
  return { s: +((s.t - t0) / 1000).toFixed(1), aob: s.pair?.aob ? Math.round(s.pair.aob / 1000) : null, rtt: s.pair?.rtt,
    cam: k('camera'), scr: k('screen'), mic: k('mic'), camW: s.out.camera?.w, scrW: s.out.screen?.w,
    camTgt: s.out.camera?.tgt ? Math.round(s.out.camera.tgt / 1000) : null, scrTgt: s.out.screen?.tgt ? Math.round(s.out.screen.tgt / 1000) : null,
    camQ: s.out.camera?.qlr, scrQ: s.out.screen?.qlr, scrFps: s.out.screen?.fps, camFps: s.out.camera?.fps };
});
const v = await v1.ev('H.snap()');
writeResult('estimate', { chrome: chrome.version, plan, marks: marks.map(m => ({ s: (m.t - t0) / 1000, mbps: m.mbps })), relay: relay.stats, viewer: v.in, series });
// Summary: for each change, seconds until the estimate crossed into the new regime.
for (const m of marks) {
  const ms = (m.t - t0) / 1000; const cap = m.mbps * 1000;
  const after = series.filter(x => x.s >= ms && x.aob);
  const pre = series.filter(x => x.s < ms && x.s > ms - 5 && x.aob).map(x => x.aob);
  const preAvg = pre.length ? Math.round(pre.reduce((a, b) => a + b) / pre.length) : null;
  const under = after.find(x => x.aob <= cap);
  const settle = after.filter(x => x.s > ms + 20 && x.s < ms + 30).map(x => x.aob);
  console.log(JSON.stringify({ at: ms, capKbps: cap, aobBefore: preAvg, firstAtOrUnderCap: under ? +(under.s - ms).toFixed(1) : null,
    aobAt: [1, 2, 3, 5, 10, 20, 29].map(d => { const x = after.find(y => y.s >= ms + d); return x ? [d, x.aob] : null; }).filter(Boolean),
    settledAvg: settle.length ? Math.round(settle.reduce((a, b) => a + b) / settle.length) : null }));
}
console.log('relay', JSON.stringify(relay.stats));
process.exit(0);
