// Joins the own transport's worklet and the modules it uses into one source string (GRYT-1818),
// so the engine can load it from a Blob whatever bundler the app uses. Runs after tsc.

import { readFileSync, writeFileSync } from "node:fs";

const dist = new URL("../dist/", import.meta.url);
// In dependency order: each one only uses what comes before it.
const parts = [
  "transport/packet.js",
  "transport/probe.js",
  "transport/workletNames.js",
  "transport/jitterBuffer.js",
  "audio/voiceEffects.js",
  "codec/opus.js",
  "transport/processors.js",
];

const source = parts
  .map((part) =>
    readFileSync(new URL(part, dist), "utf8")
      .replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
      .replace(/^export\s+(?=(const|let|function|class|async)\b)/gm, "")
      .replace(/^export\s*\{[^}]*\};?\s*$/gm, ""),
  )
  .join("\n");

if (/^\s*(import|export)\b/m.test(source)) throw new Error("an import or export survived joining the worklet source");

writeFileSync(new URL("transport/workletSource.js", dist), `export const TRANSPORT_WORKLET_SOURCE = ${JSON.stringify(source)};\n`);
console.log(`build-worklet-source: ${parts.length} modules, ${source.length} characters`);
