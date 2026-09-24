// Two video senders paused and resumed: together, staggered, or by replaceTrack instead of
// `active`. `node resume-modes.mjs [h264|vp9]`
import { startSfu, startStatic, startChrome, newGuest, joinOpts, sleep, writeResult } from './lib.mjs';
const here = new URL('.', import.meta.url).pathname;
const codec = process.argv[2] || 'h264';
await startSfu(here + 'sfu-resume3.log'); startStatic(); const chrome = await startChrome();
const snd = await newGuest(chrome, 'sender'); const v1 = await newGuest(chrome, 'v');
await snd.ev(`H.join(${joinOpts('alice', { mic: true, codec: `video/${codec}`, camera: { w: 1920, h: 1080, fps: 30, synthetic: true }, screen: { w: 1920, h: 1080, fps: 30, content: 'text' } })})`);
await sleep(1000); await v1.ev(`H.join(${joinOpts('bob', {})})`);
await sleep(12000);
await snd.ev(`H.tracks = { camera: H.senders.camera.track, screen: H.senders.screen.track }`);
const st = async () => { const o = (await snd.ev('H.snap()')).out; return { cam: o.camera.fe, scr: o.screen.fe, impl: o.camera.impl + '/' + o.screen.impl, codec: o.camera.codec }; };
const set = (n, p) => snd.ev(`H.setParams('${n}', ${JSON.stringify(p)})`);
const modes = {
  together: { pause: async () => { await set('camera', { active: false }); await set('screen', { active: false }); }, resume: async () => { await set('camera', { active: true }); await set('screen', { active: true }); } },
  staggered: { pause: async () => { await set('camera', { active: false }); await set('screen', { active: false }); }, resume: async () => { await set('camera', { active: true }); await sleep(1000); await set('screen', { active: true }); } },
  screenOnly: { pause: async () => { await set('screen', { active: false }); }, resume: async () => { await set('screen', { active: true }); } },
  cameraOnly: { pause: async () => { await set('camera', { active: false }); }, resume: async () => { await set('camera', { active: true }); } },
  replaceTrack: { pause: async () => { await snd.ev(`Promise.all([H.senders.camera.replaceTrack(null), H.senders.screen.replaceTrack(null)])`); }, resume: async () => { await snd.ev(`Promise.all([H.senders.camera.replaceTrack(H.tracks.camera), H.senders.screen.replaceTrack(H.tracks.screen)])`); } },
};
const rows = [];
for (let rep = 0; rep < 2; rep++) for (const [name, m] of Object.entries(modes)) {
  await m.pause(); await sleep(3000);
  const a = await st(); await m.resume(); await sleep(5000); const b = await st();
  const r = { mode: name, rep, cameraFramesIn5s: b.cam - a.cam, screenFramesIn5s: b.scr - a.scr, impl: b.impl, codec: b.codec };
  rows.push(r); console.log(JSON.stringify(r));
  // Reset: make sure both are running before the next mode.
  await set('camera', { active: true }); await set('screen', { active: true }); await sleep(4000);
  const c = await st(); await sleep(2000); const d = await st(); console.log('  reset check cam', d.cam - c.cam, 'scr', d.scr - c.scr);
}
writeResult(`resume-modes-${codec}`, { chrome: chrome.version, rows });
process.exit(0);
