// What spatial layers cost the sender: VP9 camera at 1080p with one spatial layer (L1T3)
// against three (L3T3_KEY), same bitrate cap. `node svc.mjs`
import { startSfu, startStatic, startChrome, newGuest, joinOpts, sleep, writeResult } from './lib.mjs';
const here = new URL('.', import.meta.url).pathname;
await startSfu(here + 'sfu-svc.log'); startStatic(); const chrome = await startChrome();
const snd = await newGuest(chrome, 'sender'); const v1 = await newGuest(chrome, 'v');
await snd.ev(`H.join(${joinOpts('alice', { mic: true, codec: 'video/vp9', camera: { w: 1920, h: 1080, fps: 30, synthetic: true } })})`);
await sleep(1000); await v1.ev(`H.join(${joinOpts('bob', {})})`);
await sleep(12000);
const rows = [];
for (const mode of ['L1T3', 'L3T3_KEY', 'L1T3', 'L3T3_KEY']) {
  for (const cap of [2500000, null]) {
    const enc = { scalabilityMode: mode }; enc.maxBitrate = cap ?? undefined;
    const res = await snd.ev(`(async()=>{ const s=H.senders.camera; const p=s.getParameters(); p.encodings[0].scalabilityMode='${mode}'; ${cap ? `p.encodings[0].maxBitrate=${cap};` : 'delete p.encodings[0].maxBitrate;'} try { await s.setParameters(p); return 'ok ' + s.getParameters().encodings[0].scalabilityMode; } catch(e) { return 'err ' + e; } })()`);
    await sleep(8000);
    const a = (await snd.ev('H.snap()')).out.camera; await sleep(12000); const b = (await snd.ev('H.snap()')).out.camera;
    const fe = b.fe - a.fe;
    const r = { mode, capKbps: cap ? cap / 1000 : null, set: res, reported: b.svc, codec: b.codec, impl: b.impl, w: b.w, h: b.h, fps: +(fe / 12).toFixed(1),
      kbps: Math.round(((b.bytes + b.hdr) - (a.bytes + a.hdr)) * 8 / 12 / 1000), encMsPerFrame: +(((b.enc - a.enc) / fe) * 1000).toFixed(2), qlr: b.qlr };
    rows.push(r); console.log(JSON.stringify(r));
  }
}
writeResult('svc-vp9-camera', { chrome: chrome.version, rows });
process.exit(0);
