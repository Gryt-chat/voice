/* eslint-env node */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "src/webrtc/hooks/useSFU.ts";
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", SOURCE),
  "utf8",
);

assert.match(
  source,
  /const room = activeTarget\?\.room \?\? target\?\.room \?\? null;/,
  "the live call no longer pins signalling to its active target",
);
assert.match(
  source,
  /activeTargetRef\.current = targetForConnection;[\s\S]*setActiveTarget\(targetForConnection\);/,
  "a successful connect target is not remembered for recovery",
);
assert.match(
  source,
  /await connectToTarget\(target, channelID, channelEsportsMode, channelMaxBitrate\);/,
  "a user-initiated connect no longer follows the server they clicked",
);
assert.match(
  source,
  /const recoveryTarget = activeTargetRef\.current;[\s\S]*await connectToTarget\(recoveryTarget, channelID\);/,
  "recovery no longer reuses the server the call actually belongs to",
);
assert.match(
  source,
  /const connectRef = useRef\(reconnectActiveTarget\);/,
  "automatic reconnect fell back to the currently viewed server",
);
assert.match(
  source,
  /const host = activeTargetRef\.current\?\.id;/,
  "server reconnect handling no longer checks the active call host",
);

console.log("reconnect target: pinned to the active call, not the viewed server");
