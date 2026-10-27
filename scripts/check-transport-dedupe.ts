// A user heard over the own transport must not also be played from their WebRTC track: the
// phone played both, a path's latency apart, and it sounded like echo (GRYT-1831).

import assert from "node:assert/strict";

// First, so the fake timers are in place before any engine module loads.
import { asReal, fakeStream, fakeTrack, log } from "./engine-harness.ts";

import { act, createElement } from "react";
import TestRenderer, { type ReactTestRenderer } from "react-test-renderer";

import { useSFUStreams } from "../dist/webrtc/hooks/useSFUStreams.js";
import type { Streams } from "../dist/webrtc/types/SFU.js";

const alice = fakeTrack("audio");
const bob = fakeTrack("audio");
const mine = fakeTrack("audio");

const streams: Streams = {
  "s-alice": { stream: asReal(fakeStream(alice)), isLocal: false, kind: "audio" as const },
  "s-bob": { stream: asReal(fakeStream(bob)), isLocal: false, kind: "audio" as const },
  "s-mine": { stream: asReal(fakeStream(mine)), isLocal: true, kind: "audio" as const },
};

interface Props {
  isDeafened: boolean;
  duplicateAudioStreams: ReadonlySet<string>;
}

/* audioContext null is the phone: the web path zeroes a gain node instead, and this effect
   is the only thing touching `enabled`, which is what makes one write correct. */
function Harness({ isDeafened, duplicateAudioStreams }: Props) {
  useSFUStreams({
    streams,
    setStreams: () => {},
    streamSources: {},
    setStreamSources: () => {},
    setVideoStreams: () => {},
    audioContext: null,
    remoteBusNode: undefined,
    outputVolume: 100,
    isDeafened,
    duplicateAudioStreams,
    isConnected: true,
    room: null,
    previousRemoteStreamsRef: { current: new Set<string>() },
  });
  return null;
}

let renderer: ReactTestRenderer;
async function render(props: Props) {
  await act(async () => {
    if (renderer) renderer.update(createElement(Harness, props));
    else renderer = TestRenderer.create(createElement(Harness, props));
  });
}

const NONE: ReadonlySet<string> = new Set();
const BOB: ReadonlySet<string> = new Set(["s-bob"]);

let failures = 0;
function check(name: string, run: () => void) {
  try {
    run();
    log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    log(`  FAIL  ${name}\n        ${err instanceof Error ? err.message : String(err)}`);
  }
}

log("transport dedupe");

await render({ isDeafened: false, duplicateAudioStreams: NONE });
check("nobody on the transport: every remote track plays", () => {
  assert.equal(alice.enabled, true);
  assert.equal(bob.enabled, true);
});

await render({ isDeafened: false, duplicateAudioStreams: BOB });
check("a user heard on the transport has their WebRTC copy silenced, and only theirs", () => {
  assert.equal(bob.enabled, false, "bob is played twice");
  assert.equal(alice.enabled, true, "alice went silent with bob");
});

await render({ isDeafened: true, duplicateAudioStreams: BOB });
check("deafened silences the rest too", () => {
  assert.equal(alice.enabled, false);
  assert.equal(bob.enabled, false);
});

/* The bug a second writer would reintroduce: undeafening re-enabled every remote track,
   including one that is still arriving over the transport. */
await render({ isDeafened: false, duplicateAudioStreams: BOB });
check("undeafening does not bring a duplicate back", () => {
  assert.equal(alice.enabled, true, "alice stayed silent after undeafening");
  assert.equal(bob.enabled, false, "bob came back as a duplicate");
});

await render({ isDeafened: false, duplicateAudioStreams: NONE });
check("leaving the transport plays their WebRTC copy again", () => {
  assert.equal(bob.enabled, true);
});

check("a local track is never touched", () => {
  assert.equal(mine.enabled, true);
});

log(failures === 0 ? "\ntransport dedupe: ok" : `\ntransport dedupe: ${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
