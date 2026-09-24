// Which congestion feedback reaches the SFU, in each direction. Needs the sfu-census build
// (sfu-rtcp-census.patch applied to Gryt-chat/sfu); BW_SFU=./sfu-census node census.mjs
import { startSfu, startStatic, startRelay, startChrome, newGuest, joinOpts, sleep, CFG, writeResult } from './lib.mjs';
import fs from 'node:fs';
const here = new URL('.', import.meta.url).pathname;
await startSfu(here + 'sfu-census.log'); startStatic(); startRelay(); const chrome = await startChrome();
const snd = await newGuest(chrome, 'sender'); const v1 = await newGuest(chrome, 'viewer1');
await snd.ev(`H.join(${joinOpts('alice', { relayPort: CFG.relayPort, mic: true, camera: { w: 1280, h: 720, fps: 30, synthetic: true }, screen: { w: 1920, h: 1080, fps: 30 } })})`);
await sleep(1500);
await v1.ev(`H.join(${joinOpts('bob', {})})`);
await sleep(30000);
const pick = (sdp) => sdp.split('\r\n').filter(l => /^(m=|a=mid|a=extmap|a=rtcp-fb:(\d+) (transport-cc|goog-remb)|a=(sendrecv|sendonly|recvonly|inactive))/.test(l));
const ss = await snd.ev('H.sdp()'), vs = await v1.ev('H.sdp()');
const out = { senderAnswer: pick(ss.local), viewerOffer: pick(vs.remote), viewerAnswer: pick(vs.local),
  census: fs.readFileSync(here + 'sfu-census.log', 'utf8').split('\n').filter(l => l.includes('[CENSUS]')).slice(-4),
  sender: await snd.ev('H.snap()'), viewer: await v1.ev('H.snap()') };
writeResult('census', out);
console.log(JSON.stringify({ ...out, sender: undefined, viewer: undefined }, null, 1));
console.log('sender pair', JSON.stringify(out.sender.pair), 'viewer pair', JSON.stringify(out.viewer.pair));
process.exit(0);
