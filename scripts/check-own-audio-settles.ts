// A call whose voice is on the own transport is up, whatever WebRTC does. On an SFU with no
// WebRTC the phone waited for a peer connection that never answered and rejoined every 20 s.

import assert from "node:assert/strict";

// First, so the fake timers and sockets are in place before any engine module loads.
import { advance, FakeSocket, fakePhonePlatform, fakeRoom, log, mountEngine, settle, voiceConfig } from "./engine-harness.ts";

import { VoiceConfigProvider } from "../dist/config/index.js";
import { setVoicePlatform } from "../dist/platform/index.js";
import { VoiceSingletonHooks } from "../dist/shared/SingletonHooks.js";
import type { NativeAudioSession } from "../dist/types.js";
import { useSFU } from "../dist/webrtc/hooks/useSFU.js";

const udp = { addrs: ["192.0.2.1:4486"], session: 7, key: `${"A".repeat(43)}=` };

/** An SFU offering the UDP session, with (Go) or without (Rust) a WebRTC offer after it. */
function sfuSocket(webrtc: boolean) {
  return class extends FakeSocket {
    send(text: string) {
      const message = JSON.parse(text);
      if (message.event !== "client_join") return webrtc ? super.send(text) : void this.sent.push(message);
      this.sent.push(message);
      this.deliver("room_joined", { call_alone_timeout_seconds: 0, audio_transport: { urls: [], certHash: "", ticket: "", udp } });
      if (webrtc) this.offer();
    }
  };
}

async function call({ webrtc, engine: hasEngine }: { webrtc: boolean; engine: boolean }) {
  Object.assign(globalThis, { WebSocket: sfuSocket(webrtc) });
  const phone = fakePhonePlatform();
  const native = { started: 0, closed: 0 };
  const session: NativeAudioSession = {
    setSending() {},
    setOutputGain() {},
    setEffects() {},
    speaking: () => [],
    setGains() {},
    levels: () => ({ ids: [], db: [], mic: -120, micSpeaking: false }),
    latency: () => ({ ids: [], bufferedMs: [], inputMs: 0, outputMs: 0, ioBufferMs: 0, sampleRate: 48000, rttMs: [] }),
    close: () => void native.closed++,
  };
  if (hasEngine) phone.startNativeAudio = async () => (native.started++, session);
  setVoicePlatform(phone);
  const seen = new Set<string>();
  const base = voiceConfig({ stunHosts: ["stun:a.test"] });
  const engine = await mountEngine({
    provider: VoiceConfigProvider,
    runner: VoiceSingletonHooks,
    useRead: () => {
      const sfu = useSFU();
      seen.add(sfu.connectionState);
      return sfu;
    },
    config: { ...base, connection: { ...base.connection, nativeAudio: true } },
    target: { id: "server-a", room: fakeRoom("server-a") },
  });
  // The engine is a singleton, so the last scenario's state shows on the first render.
  seen.clear();
  await settle(() => {
    engine.current.connect("chan-a").catch(() => {});
  });
  await advance(1_000);
  return { phone, native, engine, seen, sfu: () => engine.current };
}

// The Rust SFU: no WebRTC offer at all. The engine carries voice, so the call is up and stays up.
{
  const { phone, native, engine, seen, sfu } = await call({ webrtc: false, engine: true });
  assert.equal(native.started, 1, "the native engine never started on a UDP-only offer");
  assert.equal(sfu().connectionState, "connected", "voice is on the engine and the call still reads as connecting");
  await advance(180_000);
  assert.equal(sfu().connectionState, "connected", `the call left connected without WebRTC: ${[...seen]}`);
  assert.ok(!seen.has("failed") && !seen.has("reconnecting"), `the call was torn down for WebRTC: ${[...seen]}`);
  assert.equal(phone.peers.length, 1, "the call rejoined");
  assert.equal(native.closed, 0, "the engine was stopped mid-call");
  await engine.unmount();
}

// Nothing carries voice but WebRTC, and it never connects: that still fails the call.
{
  const { engine, seen } = await call({ webrtc: false, engine: false });
  await advance(21_000);
  assert.ok(seen.has("failed"), `a call with no voice path never failed: ${[...seen]}`);
  assert.ok(!seen.has("connected"), `a call with no voice path read as connected: ${[...seen]}`);
  await engine.unmount();
}

// The Go SFU: WebRTC connects as before, and its failing later doesn't end a call the engine carries.
{
  const { phone, native, engine, sfu } = await call({ webrtc: true, engine: true });
  await settle(() => phone.lastPeer().reach("connected"));
  assert.equal(sfu().connectionState, "connected");
  await settle(() => phone.lastPeer().reach("failed"));
  await advance(30_000);
  assert.equal(sfu().connectionState, "connected", "WebRTC failing ended a call whose voice is on the engine");
  assert.equal(native.closed, 0, "the engine was stopped when WebRTC failed");
  await engine.unmount();
}

log("own audio settles: voice on the own transport is a connected call, with or without WebRTC");
