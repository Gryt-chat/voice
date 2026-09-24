// Does a paused sender come back when the same setParameters call also changes its size?
// `node resume.mjs [screen|camera] [h264|vp9]`
import { startSfu, startStatic, startChrome, newGuest, joinOpts, sleep, writeResult } from './lib.mjs';
const here = new URL('.', import.meta.url).pathname;
const which = process.argv[2] || 'screen', codec = process.argv[3] || 'h264';
await startSfu(here + 'sfu-resume.log'); startStatic(); const chrome = await startChrome();
const snd = await newGuest(chrome, 'sender'); const v1 = await newGuest(chrome, 'v');
const media = which === 'camera' ? { camera: { w: 1920, h: 1080, fps: 30, synthetic: true } } : { screen: { w: 1920, h: 1080, fps: 30, content: 'text' } };
await snd.ev(`H.join(${joinOpts('alice', { codec: `video/${codec}`, ...media })})`);
await sleep(1000); await v1.ev(`H.join(${joinOpts('bob', {})})`);
await sleep(6000);
const st = async () => { const s = (await snd.ev('H.snap()')).out[which]; const v = Object.values((await v1.ev('H.snap()')).in)[0]; return { fe: s.fe, kf: s.kf, w: s.w, codec: s.codec, vfd: v?.fd, vw: v?.w, vpli: v?.pli }; };
const rows = [];
const trial = async (label, pre, resume, holdMs = 2500) => {
  for (const p of pre) { await snd.ev(`H.setParams('${which}', ${JSON.stringify(p)})`); await sleep(p.active === false ? holdMs : 2500); }
  const a = await st(); await snd.ev(`H.setParams('${which}', ${JSON.stringify(resume)})`); await sleep(4000); const b = await st(); const pair = (await snd.ev('H.snap()')).pair;
  const r = { label, framesIn4s: b.fe - a.fe, keyframes: b.kf - a.kf, viewerDecoded: b.vfd - a.vfd, size: b.w, viewerPli: b.vpli - a.vpli, codec: b.codec, pausedMs: holdMs, aobKbpsAfter: pair?.aob ? Math.round(pair.aob / 1000) : null };
  rows.push(r); console.log(JSON.stringify(r));
  await snd.ev(`H.setParams('${which}', { active: true, scaleResolutionDownBy: 1 })`); await sleep(3000);
};
await trial('pause at 1x, resume same size', [{ active: false }], { active: true });
await trial('pause at 3x, resume same size', [{ scaleResolutionDownBy: 3 }, { active: false }], { active: true });
await trial('pause at 3x, resume at 1x in one call', [{ scaleResolutionDownBy: 3 }, { active: false }], { active: true, scaleResolutionDownBy: 1 });
await trial('pause at 3x, resize while paused, then resume', [{ scaleResolutionDownBy: 3 }, { active: false }, { scaleResolutionDownBy: 1 }], { active: true });
await trial('pause at 1x, resume at 3x in one call', [{ active: false }], { active: true, scaleResolutionDownBy: 3 });
await trial('pause 25 s at 1x, resume same size', [{ active: false }], { active: true }, 25000);
await trial('pause 25 s at 3x, resume at 1x in one call', [{ scaleResolutionDownBy: 3 }, { active: false }], { active: true, scaleResolutionDownBy: 1 }, 25000);
writeResult(`resume-${which}-${codec}`, { chrome: chrome.version, rows });
process.exit(0);
