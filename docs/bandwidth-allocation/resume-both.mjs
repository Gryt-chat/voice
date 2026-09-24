// Camera and share paused together and resumed together, as the allocator would when the
// last viewer looks away and comes back. `BW_RELAY=1 node resume-both.mjs` sends through the shaper.
import { startSfu, startStatic, startRelay, startChrome, newGuest, joinOpts, sleep, CFG, writeResult } from './lib.mjs';
const here = new URL('.', import.meta.url).pathname;
const viaRelay = !!process.env.BW_RELAY;
await startSfu(here + 'sfu-resume2.log'); startStatic(); startRelay(); const chrome = await startChrome();
const snd = await newGuest(chrome, 'sender'); const v1 = await newGuest(chrome, 'v');
await snd.ev(`H.join(${joinOpts('alice', { relayPort: viaRelay ? CFG.relayPort : undefined, mic: true, camera: { w: 1920, h: 1080, fps: 30, synthetic: true }, screen: { w: 1920, h: 1080, fps: 30, content: 'text' } })})`);
await sleep(1000); await v1.ev(`H.join(${joinOpts('bob', {})})`);
await sleep(15000);
const st = async () => { const o = (await snd.ev('H.snap()')).out; return { cam: o.camera.fe, scr: o.screen.fe, scrKf: o.screen.kf, camKf: o.camera.kf }; };
const set = (n, p) => snd.ev(`H.setParams('${n}', ${JSON.stringify(p)})`);
const rows = [];
for (const [label, pauseMs, resume] of [['25 s pause, resume same size', 25000, { active: true }], ['25 s pause at 3x, resume at 1x', 25000, { active: true, scaleResolutionDownBy: 1 }], ['3 s pause, resume same size', 3000, { active: true }]]) {
  if (resume.scaleResolutionDownBy) { await set('camera', { scaleResolutionDownBy: 3 }); await set('screen', { scaleResolutionDownBy: 3 }); await sleep(3000); }
  await set('camera', { active: false }); await set('screen', { active: false }); await sleep(pauseMs);
  const a = await st(); await set('camera', resume); await set('screen', resume); await sleep(5000); const b = await st();
  const r = { label, viaRelay, cameraFramesIn5s: b.cam - a.cam, screenFramesIn5s: b.scr - a.scr, cameraKeyframes: b.camKf - a.camKf, screenKeyframes: b.scrKf - a.scrKf };
  rows.push(r); console.log(JSON.stringify(r));
  await set('camera', { active: true, scaleResolutionDownBy: 1 }); await set('screen', { active: true, scaleResolutionDownBy: 1 }); await sleep(5000);
}
writeResult(`resume-both-${viaRelay ? 'relay' : 'direct'}`, { chrome: chrome.version, rows });
process.exit(0);
