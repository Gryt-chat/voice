/* eslint-env node */

// Runs the effect that swaps the sent audio track after the pipeline rebuilds.
// Measured against two clients in a call, it fired twice per rebuild. GRYT-1073.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "src/webrtc/hooks/useSFU.ts";
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", SOURCE),
  "utf8",
);

/** The effect body, from its arrow's brace to the brace that closes it. */
function effectBody(text, marker) {
  const anchor = text.indexOf(marker);
  assert.notEqual(anchor, -1, `${SOURCE} no longer has "${marker}". Move this check with it.`);

  const OPENER = "useEffect(() => {";
  const opener = text.indexOf(OPENER, anchor);
  const start = opener + OPENER.length - 1;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after "${marker}" in ${SOURCE}`);
}

// Plain JavaScript already — the effect carries no type annotations.
const body = effectBody(source, "Monitor processedStream changes");

function fakeTrack(id, kind = "audio") {
  return { id, kind };
}

/**
 * One audio sender, and a stream that has already moved on. `localTrack` is what
 * the streams state still holds, which is not always what the sender holds.
 */
function harness({ senderTrack, newTrack, localStreamId, localTrack }) {
  const replaced = [];
  const sender = {
    track: senderTrack,
    replaceTrack(t) {
      replaced.push({ from: sender.track?.id ?? null, to: t?.id ?? null });
      sender.track = t;
      return Promise.resolve();
    },
  };

  const newStream = { id: "stream-new", getAudioTracks: () => [newTrack] };
  const streams = {
    [localStreamId]: {
      isLocal: true,
      stream: { id: localStreamId, getAudioTracks: () => [localTrack ?? senderTrack] },
    },
    remote: { isLocal: false, stream: { id: "remote", getAudioTracks: () => [] } },
  };

  let wrote = null;
  const run = new Function(
    "isConnected",
    "peerConnectionRef",
    "registeredTracksRef",
    "microphoneBuffer",
    "streams",
    "setStreams",
    "console",
    `return (() => ${body})();`,
  );

  run(
    true,
    { current: {} },
    { current: [sender] },
    { processedStream: newStream, mediaStream: newStream },
    streams,
    (fn) => (wrote = fn(streams)),
    { error: () => {} },
  );

  return { replaced, sender, wrote: () => wrote };
}

// A rebuilt pipeline swaps the sent track, once, and the state follows it.
{
  const old = fakeTrack("old");
  const { replaced, sender, wrote } = harness({
    senderTrack: old,
    newTrack: fakeTrack("new"),
    localStreamId: "stream-old",
  });
  assert.deepEqual(
    replaced,
    [{ from: "old", to: "new" }],
    "the rebuilt track is not sent, or is sent more than once",
  );
  assert.equal(sender.track.id, "new", "the sender kept the old track");

  // The replace resolves a microtask later, and the state write is in its then.
  await new Promise((resolve) => setImmediate(resolve));
  const next = wrote();
  assert.ok(next, "the streams state was never written, so the local tile keeps the old stream");
  const local = Object.entries(next).filter(([, s]) => s.isLocal);
  assert.deepEqual(
    local.map(([id]) => id),
    ["stream-new"],
    "the local stream entry does not point at the rebuilt stream",
  );
  assert.ok(next.remote, "the remote streams were dropped along with the swap");
}

// The duplicate this exists for: the by-kind effect above swapped the sender
// already, but the streams state is stale, so the change still reads as real.
{
  const shared = fakeTrack("new");
  const { replaced } = harness({
    senderTrack: shared,
    newTrack: shared,
    localTrack: fakeTrack("old"),
    localStreamId: "stream-old",
  });
  assert.deepEqual(replaced, [], "the track is replaced again when it is already the sent one");
}

/*
 * A new stream object carrying the same track writes nothing. `streams` is in
 * this effect's own dependencies, so a write here schedules another run of it.
 */
{
  const shared = fakeTrack("same");
  const { replaced, wrote } = harness({
    senderTrack: shared,
    newTrack: shared,
    localTrack: shared,
    localStreamId: "stream-old",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replaced, [], "an unchanged track is replaced anyway");
  assert.equal(wrote(), null, "the state is rewritten for a stream whose tracks did not change");
}

// A video sender first in the list must not be handed an audio track.
{
  const audio = fakeTrack("old");
  const video = fakeTrack("cam", "video");
  const replaced = [];
  const senders = [
    { track: video, replaceTrack: (t) => (replaced.push({ on: "video", to: t.id }), Promise.resolve()) },
    { track: audio, replaceTrack(t) { replaced.push({ on: "audio", to: t.id }); this.track = t; return Promise.resolve(); } },
  ];
  const next = fakeTrack("new");
  const newStream = { id: "stream-new", getAudioTracks: () => [next] };
  new Function(
    "isConnected", "peerConnectionRef", "registeredTracksRef",
    "microphoneBuffer", "streams", "setStreams", "console",
    `return (() => ${body})();`,
  )(
    true,
    { current: {} },
    { current: senders },
    { processedStream: newStream, mediaStream: newStream },
    { old: { isLocal: true, stream: { id: "old", getAudioTracks: () => [audio] } } },
    () => {},
    { error: () => {} },
  );
  assert.deepEqual(
    replaced,
    [{ on: "audio", to: "new" }],
    "an audio track was put on a video sender, which replaceTrack rejects",
  );
}

// Nothing happens while disconnected.
{
  const body2 = body;
  const replaced = [];
  new Function(
    "isConnected", "peerConnectionRef", "registeredTracksRef",
    "microphoneBuffer", "streams", "setStreams", "console",
    `return (() => ${body2})();`,
  )(
    false,
    { current: {} },
    { current: [{ track: fakeTrack("old"), replaceTrack: (t) => (replaced.push(t.id), Promise.resolve()) }] },
    { processedStream: { id: "s", getAudioTracks: () => [fakeTrack("new")] } },
    {},
    () => {},
    { error: () => {} },
  );
  assert.deepEqual(replaced, [], "tracks are replaced while not connected");
}

console.log("track replace: ok, once per rebuild, by kind, not while disconnected");
