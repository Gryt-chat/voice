import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/webrtc/hooks/useSFU.ts", import.meta.url), "utf8");

assert.match(source, /const activeTargetRef = useRef\(target\)/);
assert.match(
  source,
  /connectionState\.state === SFUConnectionState\.DISCONNECTED[\s\S]*?activeTargetRef\.current\?\.room/,
  "the viewed server must not replace the active call room",
);
assert.match(
  source,
  /activeTargetRef\.current = targetForConnect/,
  "a successful connect attempt must snapshot the server it is using",
);
assert.match(
  source,
  /const host = activeTargetRef\.current\?\.id/,
  "server-socket recovery must compare against the active call server",
);

const recoveryCalls = source.match(
  /connectRef\.current\(channelId, undefined, undefined, activeTargetRef\.current\)/g,
) ?? [];
assert.ok(
  recoveryCalls.length >= 3,
  "every automatic reconnect path must reuse the active call target",
);

console.log("active call target recovery checks passed");
