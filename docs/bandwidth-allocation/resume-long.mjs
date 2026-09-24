// How senders come back after a pause long enough for the estimate to fall to the mic's rate.
// `node resume-long.mjs [both|screen-alone|camera-alone] [seconds] [together|screen-first|camera-first|balanced|rekick]`
import { startSfu, startStatic, startChrome, newGuest, joinOpts, sleep, writeResult } from './lib.mjs';
const here = new URL('.', import.meta.url).pathname;
const which = process.argv[2] || 'both', pauseS = +(process.argv[3] || 25), how = process.argv[4] || 'together';
await startSfu(here + 'sfu-resume4.log'); startStatic(); const chrome = await startChrome();
const snd = await newGuest(chrome, 'sender'); const v1 = await newGuest(chrome, 'v');
await snd.ev(`H.join(${joinOpts('alice', { mic: true, camera: { w: 1920, h: 1080, fps: 30, synthetic: true }, screen: { w: 1920, h: 1080, fps: 30, content: 'text' } })})`);
await sleep(1000); await v1.ev(`H.join(${joinOpts('bob', {})})`);
await sleep(15000);
const set = (n, p) => snd.ev(`H.setParams('${n}', ${JSON.stringify(p)})`);
const names = which === 'both' ? ['camera', 'screen'] : [which.replace('-alone', '')];
for (const n of names) await set(n, { active: false });
await sleep(pauseS * 1000);
const before = await snd.ev('H.snap()');
if (how === 'balanced') await snd.ev(`H.setParams('screen', {}, { degradationPreference: 'balanced' })`);
const order = how === 'screen-first' ? ['screen', 'camera'] : how === 'camera-first' ? ['camera', 'screen'] : names;
const gap = how.endsWith('-first') ? 3 : 0;
if (gap) { await set(order[0], { active: true }); } else for (const n of names) await set(n, { active: true });
const series = []; let prev = before;
for (let i = 1; i <= 30; i++) {
  await sleep(1000);
  if (gap && i === gap) await set(order[1], { active: true });
  const s = await snd.ev('H.snap()');
  // Watchdog: a sender that encoded nothing in the last second gets toggled off and on.
  if (how === 'rekick' && i >= 2) for (const n of names) { if (s.out[n].fe === prev.out[n].fe) { await set(n, { active: false }); await set(n, { active: true }); console.log('rekick', n, 'at', i); } }
  const row = { s: i, aob: Math.round((s.pair?.aob || 0) / 1000) };
  for (const n of ['camera', 'screen']) { const a = prev.out[n], b = s.out[n]; row[n] = { fps: b.fe - a.fe, w: b.w, tgt: Math.round((b.tgt || 0) / 1000), kbps: Math.round(((b.bytes + b.hdr) - (a.bytes + a.hdr)) * 8 / 1000), q: b.qlr }; }
  series.push(row); prev = s;
}
console.log(how, 'aob before resume', Math.round((before.pair?.aob || 0) / 1000));
for (const r of series) if ([1, 2, 3, 5, 10, 15, 20, 30].includes(r.s)) console.log(JSON.stringify(r));
writeResult(`resume-long-${which}-${pauseS}s-${how}`, { chrome: chrome.version, which, pauseS, how, aobBeforeResume: before.pair?.aob, series });
process.exit(0);
