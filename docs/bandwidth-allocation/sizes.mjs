// Bytes per size: scaleResolutionDownBy on each video sender, 15 s averages, unshaped.
// `node sizes.mjs [text|motion] [h264|vp9] [both|camera|screen]`, BW_NORELAY=1 skips the relay
import { startSfu, startStatic, startRelay, startChrome, newGuest, joinOpts, sleep, CFG, writeResult } from './lib.mjs';
const here = new URL('.', import.meta.url).pathname;
const content = process.argv[2] || 'text', codec = process.argv[3] || 'h264', only = process.argv[4] || 'both';
const cam = only !== 'screen', scr = only !== 'camera';
await startSfu(here + 'sfu-sizes.log'); startStatic(); const relay = startRelay(); const chrome = await startChrome();
const snd = await newGuest(chrome, 'sender'); const v1 = await newGuest(chrome, 'viewer1');
await snd.ev(`H.join(${joinOpts('alice', { relayPort: process.env.BW_NORELAY ? undefined : CFG.relayPort, mic: true, codec: `video/${codec}`, camera: cam ? { w: 1920, h: 1080, fps: 30, synthetic: true } : null, screen: scr ? { w: 1920, h: 1080, fps: 30, content } : null })})`);
await sleep(1500);
await v1.ev(`H.join(${joinOpts('bob', { viewW: 1920, viewH: 1080 })})`);
await sleep(20000); // let the estimate ramp before the first step
const steps = [
  { label: '1080p', enc: { scaleResolutionDownBy: 1, active: true } },
  { label: '720p', enc: { scaleResolutionDownBy: 1.5, active: true } },
  { label: '360p', enc: { scaleResolutionDownBy: 3, active: true } },
  { label: 'paused', enc: { active: false } },
  { label: '1080p again', enc: { scaleResolutionDownBy: 1, active: true } },
];
const rows = [];
for (const st of steps) {
  if (cam) await snd.ev(`H.setParams('camera', ${JSON.stringify(st.enc)})`);
  if (scr) await snd.ev(`H.setParams('screen', ${JSON.stringify(st.enc)})`);
  await sleep(10000);
  const a = await snd.ev('H.snap()'); const va = await v1.ev('H.snap()'); const ra = { ...relay.stats };
  await sleep(15000);
  const b = await snd.ev('H.snap()'); const vb = await v1.ev('H.snap()'); const rb = { ...relay.stats };
  const dt = (b.t - a.t) / 1000;
  const row = { label: st.label, seconds: dt, wireKbps: Math.round((rb.outBytes - ra.outBytes) * 8 / dt / 1000) };
  for (const k of ['camera', 'screen', 'mic']) {
    const x = a.out[k], y = b.out[k]; if (!x || !y) continue;
    const fe = y.fe - x.fe;
    row[k] = { w: y.w, h: y.h, fps: +((fe || 0) / dt).toFixed(1),
      kbps: Math.round(((y.bytes + y.hdr) - (x.bytes + x.hdr)) * 8 / dt / 1000),
      targetKbps: y.tgt ? Math.round(y.tgt / 1000) : null, qlr: y.qlr,
      encMsPerFrame: fe ? +(((y.enc - x.enc) / fe) * 1000).toFixed(2) : null, keyframes: (y.kf || 0) - (x.kf || 0), impl: y.impl, codec: y.codec };
  }
  row.aobKbps = b.pair?.aob ? Math.round(b.pair.aob / 1000) : null;
  row.viewer = Object.fromEntries(Object.entries(vb.in).map(([id, s]) => [id.slice(0, 8), { w: s.w, h: s.h, kbps: Math.round(((s.bytes + s.hdr) - ((va.in[id]?.bytes || 0) + (va.in[id]?.hdr || 0))) * 8 / dt / 1000), dropped: s.drop - (va.in[id]?.drop || 0) }]));
  rows.push(row);
  console.log(JSON.stringify(row));
}
writeResult(`sizes-${only}-${content}-${codec}`, { chrome: chrome.version, content, codec, rows });
process.exit(0);
