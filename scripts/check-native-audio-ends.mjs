/* eslint-env node */

// Runs the effect that mirrors the native capture stream into screenAudioStream.
// A helper that exits mid-share has to take the shared audio stream with it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "src/audio/hooks/useScreenShare.ts";
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", SOURCE),
  "utf8",
);

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

const body = effectBody(source, "Sync native capture stream");
const effect = new Function(
  "usingNativeAudioRef",
  "nativeStream",
  "setScreenAudioStream",
  "console",
  `return (() => ${body})();`,
);

const quiet = { log: () => {}, warn: () => {} };

function fakeStream(id) {
  const track = { id: `${id}-track`, label: "", enabled: true, readyState: "live", muted: false };
  return { id, getAudioTracks: () => [track] };
}

/** One share's worth of screenAudioStream, fed the native stream value by value. */
function share({ native, initial = null }) {
  const ref = { current: native };
  let screenAudioStream = initial;
  const writes = [];
  const set = (s) => {
    writes.push(s?.id ?? null);
    screenAudioStream = s;
  };
  return {
    ref,
    writes,
    get screenAudioStream() {
      return screenAudioStream;
    },
    nativeStreamIs(stream) {
      effect(ref, stream, set, quiet);
    },
  };
}

// The helper exits during a native share: the dead stream is dropped.
{
  const s = share({ native: true });
  const helper = fakeStream("native-dest");
  s.nativeStreamIs(helper);
  assert.equal(s.screenAudioStream?.id, "native-dest", "the native stream never reached screenAudioStream");

  s.nativeStreamIs(null);
  assert.equal(s.screenAudioStream, null, "screenAudioStream still holds a native stream that stopped");
  assert.equal(
    s.screenAudioStream?.id ?? "",
    "",
    "the shared audio stream id is still there to be announced after the helper exited",
  );
}

// Browser loopback audio is not the native stream's to clear.
{
  const raw = fakeStream("raw-loopback");
  const s = share({ native: false, initial: raw });
  s.nativeStreamIs(null);
  assert.equal(s.screenAudioStream, raw, "browser screen audio was cleared by a native stream it never used");
  assert.deepEqual(s.writes, [], "browser screen audio was written at all");
}

// stopScreenShare lowers the flag before the stream goes, and clears the audio itself.
{
  const s = share({ native: true });
  s.nativeStreamIs(fakeStream("native-dest"));
  s.ref.current = false;
  s.nativeStreamIs(null);
  assert.deepEqual(s.writes, ["native-dest"], "an ordinary stop wrote screenAudioStream a second time");
}

console.log("native audio ends: ok, dead native stream dropped, browser audio untouched");
