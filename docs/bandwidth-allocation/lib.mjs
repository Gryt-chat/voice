// Rig for GRYT-1321: a real SFU binary, a fake server registration, a UDP shaper in front
// of the sender, and headless Chrome guests driven over CDP.
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const CFG = {
  // A LAN address, since Chrome gathers no loopback candidates.
  host: process.env.BW_HOST || Object.values(os.networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal)?.address,
  sfuBin: process.env.BW_SFU || path.join(HERE, 'sfu-main'),
  sfuPort: 5741, muxPort: 5742, metricsPort: 5743, controlPort: 5744,
  httpPort: 5746, relayPort: 5747, cdpPort: 9471,
  room: 'bw-room', server: 'bw-server', password: 'bw-secret-not-real',
};

const cleanups = [];
export function onExit(fn) { cleanups.push(fn); }
let exiting = false;
function bye() { if (exiting) return; exiting = true; for (const f of cleanups.reverse()) { try { f(); } catch {} } }
process.on('exit', bye);
process.on('uncaughtException', (e) => { console.error(e); bye(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); bye(); process.exit(1); });
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { bye(); process.exit(1); });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startSfu(logFile) {
  const env = {
    ...process.env, SFU_PORT: String(CFG.sfuPort), ICE_UDP_MUX_PORT: String(CFG.muxPort),
    ICE_ADVERTISE_IP: CFG.host, DISABLE_STUN: 'true', SFU_REQUIRE_CLIENT_TOKEN: 'false',
    SFU_METRICS_PORT: String(CFG.metricsPort), SFU_METRICS_HOST: '127.0.0.1',
    SFU_CONTROL_PORT: String(CFG.controlPort), SFU_CONTROL_HOST: '127.0.0.1',
    DEBUG: process.env.BW_SFU_DEBUG || 'false', SFU_CALL_ALONE_TIMEOUT: '0',
  };
  const out = fs.openSync(logFile, 'w');
  const p = spawn(CFG.sfuBin, [], { env, cwd: path.dirname(logFile), stdio: ['ignore', out, out] });
  onExit(() => p.kill('SIGKILL'));
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    try { const r = await fetch(`http://127.0.0.1:${CFG.sfuPort}/health`); if (r.ok) break; } catch {}
  }
  const ws = new WebSocket(`ws://127.0.0.1:${CFG.controlPort}/server`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const reply = new Promise((res) => { ws.onmessage = (m) => res(String(m.data)); });
  ws.send(JSON.stringify({ event: 'server_register', data: JSON.stringify({ server_id: CFG.server, server_password: CFG.password, room_id: CFG.room }) }));
  console.error('sfu register:', (await reply).slice(0, 120));
  onExit(() => ws.close());
  return { proc: p, ws };
}

export function startStatic() {
  const srv = http.createServer((req, res) => {
    const f = path.join(HERE, 'harness.html');
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(fs.readFileSync(f));
  });
  srv.listen(CFG.httpPort, '127.0.0.1');
  onExit(() => srv.close());
  return srv;
}

// Shapes guest -> SFU: `rate` bits/s, a `bufferMs` drop-tail queue, `delayMs` each way.
// One upstream socket per source address, like a NAT, so ICE pairs don't mix.
export function startRelay() {
  const shape = { rate: 1e9, bufferMs: 150, delayMs: 15 };
  const stats = { inBytes: 0, outBytes: 0, dropped: 0, droppedBytes: 0, downBytes: 0 };
  const down = dgram.createSocket('udp4');
  down.bind(CFG.relayPort, CFG.host);
  const ups = new Map();
  let linkFreeAt = 0;
  down.on('message', (msg, rinfo) => {
    const key = `${rinfo.address}:${rinfo.port}`;
    let up = ups.get(key);
    if (!up) {
      up = dgram.createSocket('udp4'); up.bind(0, CFG.host); ups.set(key, up);
      up.on('message', (m) => { stats.downBytes += m.length; setTimeout(() => down.send(m, rinfo.port, rinfo.address), shape.delayMs); });
    }
    stats.inBytes += msg.length;
    const now = performance.now();
    const start = Math.max(now, linkFreeAt);
    if (start - now > shape.bufferMs) { stats.dropped++; stats.droppedBytes += msg.length; return; }
    const txMs = (msg.length + 28) * 8 / shape.rate * 1000;
    linkFreeAt = start + txMs;
    setTimeout(() => { stats.outBytes += msg.length; up.send(msg, CFG.muxPort, CFG.host); }, linkFreeAt - now + shape.delayMs);
  });
  onExit(() => { try { down.close(); } catch {} for (const u of ups.values()) try { u.close(); } catch {} });
  return { shape, stats, set(o) { Object.assign(shape, o); } };
}

class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.handlers = [];
    this.ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && this.pending.has(d.id)) { const [res, rej] = this.pending.get(d.id); this.pending.delete(d.id); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); } else for (const h of this.handlers) h(d); };
  }
  open() { return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; }); }
  send(method, params = {}, sessionId) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params, sessionId })); return new Promise((res, rej) => this.pending.set(id, [res, rej])); }
}

export async function startChrome() {
  const bin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gryt1321-chrome-'));
  const p = spawn(bin, [
    '--headless=new', `--remote-debugging-port=${CFG.cdpPort}`, `--user-data-dir=${dir}`,
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });
  onExit(() => { p.kill('SIGKILL'); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  let ver;
  for (let i = 0; i < 50; i++) { await sleep(200); try { ver = await (await fetch(`http://127.0.0.1:${CFG.cdpPort}/json/version`)).json(); break; } catch {} }
  const cdp = new CDP(ver.webSocketDebuggerUrl); await cdp.open();
  console.error('chrome', ver.Browser, 'pid', p.pid);
  return { proc: p, cdp, version: ver.Browser };
}

export async function newGuest(chrome, name) {
  const { cdp } = chrome;
  const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${CFG.httpPort}/`, browserContextId });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Browser.grantPermissions', { browserContextId, origin: `http://127.0.0.1:${CFG.httpPort}`, permissions: ['videoCapture', 'audioCapture'] });
  await sleep(800);
  const g = {
    name,
    async ev(expr) {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(`${name}: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
      return r.result.value;
    },
  };
  const href = await g.ev('location.href + " " + document.title');
  if (!href.includes('bw harness')) throw new Error(`guest ${name} landed on ${href}`);
  return g;
}

export function joinOpts(user, extra) {
  return JSON.stringify({ sfu: `ws://127.0.0.1:${CFG.sfuPort}/client`, room: CFG.room, server: CFG.server, password: CFG.password, user, relayHost: CFG.host, ...extra });
}

export function kbps(bytesA, bytesB, tA, tB) { return Math.round((bytesB - bytesA) * 8 / (tB - tA)); }
export function writeResult(name, data) {
  const dir = path.join(HERE, 'results'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 1));
}
