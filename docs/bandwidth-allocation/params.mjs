// How fast a setParameters change reaches a viewer, and what it costs: keyframes and the
// longest gap between frames the viewer drew. `node params.mjs [camera|screen] [h264|vp9]`
import { startSfu, startStatic, startChrome, newGuest, joinOpts, sleep, writeResult } from './lib.mjs';
const here = new URL('.', import.meta.url).pathname;
const which = process.argv[2] || 'camera', codec = process.argv[3] || 'h264';
await startSfu(here + 'sfu-params.log'); startStatic(); const chrome = await startChrome();
const snd = await newGuest(chrome, 'sender'); const v1 = await newGuest(chrome, 'viewer1');
const media = which === 'camera' ? { camera: { w: 1920, h: 1080, fps: 30, synthetic: true } } : { screen: { w: 1920, h: 1080, fps: 30, content: 'text' } };
await snd.ev(`H.join(${joinOpts('alice', { mic: true, codec: `video/${codec}`, ...media })})`);
await sleep(1500);
await v1.ev(`H.join(${joinOpts('bob', { viewW: 1920, viewH: 1080 })})`);
await sleep(15000);
// Pin the camera's bitrate so the encoder's own adaptation doesn't move the size under us.
if (which === 'camera') await snd.ev(`H.setParams('camera', { maxBitrate: 2500000 })`);
await sleep(3000);
const changes = [];
for (let rep = 0; rep < 3; rep++) {
  changes.push({ label: 'scale 1 -> 2', enc: { scaleResolutionDownBy: 2 } }, { label: 'scale 2 -> 1', enc: { scaleResolutionDownBy: 1 } },
    { label: 'scale 1 -> 4', enc: { scaleResolutionDownBy: 4 } }, { label: 'scale 4 -> 1', enc: { scaleResolutionDownBy: 1 } },
    { label: 'pause', enc: { active: false } }, { label: 'resume', enc: { active: true } },
    { label: 'fps 30 -> 10', enc: { maxFramerate: 10 } }, { label: 'fps 10 -> 30', enc: { maxFramerate: 30 } });
}
const results = [];
await v1.ev('H.takeFrames()');
for (const ch of changes) {
  const before = (await snd.ev('H.snap()')).out[which];
  const vbefore = Object.values((await v1.ev('H.snap()')).in)[0];
  const { t0, t1 } = await snd.ev(`H.setParams('${which}', ${JSON.stringify(ch.enc)})`);
  // Sender: poll until the encoder reports the new state, up to 3 s.
  const senderSeen = await snd.ev(`(async () => {
    const want = ${JSON.stringify(ch.enc)}; const t0 = ${t0};
    const b = ${JSON.stringify(before)};
    for (let i = 0; i < 100; i++) {
      const s = (await H.snap()).out['${which}'];
      if ('scaleResolutionDownBy' in want && s.w && s.w !== b.w) return { ms: Date.now() - t0, w: s.w, h: s.h };
      if (want.active === true && s.fe > b.fe) return { ms: Date.now() - t0, fe: s.fe - b.fe };
      if (want.active === false && i > 3) { const s2 = (await H.snap()).out['${which}']; if (s2.fe === s.fe) return { ms: Date.now() - t0, stopped: true }; }
      if ('maxFramerate' in want && i > 30) return { ms: null, fps: s.fps };
      await new Promise(r => setTimeout(r, 30));
    }
    return { ms: null };
  })()`);
  await sleep(ch.label === 'pause' ? 4000 : 5000);
  const after = (await snd.ev('H.snap()')).out[which];
  const vafter = Object.values((await v1.ev('H.snap()')).in)[0];
  const fr = Object.values(await v1.ev('H.takeFrames()'))[0] || [];
  // Viewer: first frame drawn at a new size, and the longest gap between drawn frames
  // from 0.5 s before the change to the end of the window.
  let firstNew = null, maxGap = 0, prev = null, n = 0;
  for (const [ts, w, h] of fr) {
    if (ts < t0 - 500) { prev = ts; continue; }
    n++;
    if (prev !== null) maxGap = Math.max(maxGap, ts - prev);
    prev = ts;
    if (firstNew === null && ts >= t0 && vbefore && w !== vbefore.w) firstNew = { ms: Math.round(ts - t0), w, h };
  }
  const r = { label: ch.label, setParametersMs: t1 - t0, sender: senderSeen,
    keyframesEncoded: after.kf - before.kf, keyframesDecoded: vafter.kf - vbefore.kf,
    viewerFirstNewSize: firstNew, viewerMaxGapMs: Math.round(maxGap), viewerFramesDrawn: n,
    viewerFreezes: vafter.freeze - vbefore.freeze, viewerPli: vafter.pli - vbefore.pli,
    senderFpsAfter: after.fps, sizeAfter: `${after.w}x${after.h}`, codec: after.codec, impl: after.impl };
  results.push(r); console.log(JSON.stringify(r));
  if (ch.label === 'pause') await sleep(0);
}
writeResult(`params-${which}-${codec}`, { chrome: chrome.version, which, codec, results });
process.exit(0);
