// Asserts the React Native entry cannot reach the web-only code: a phone bundle must carry
// no AudioContext, no AudioWorklet and no Worker. Nothing else enforces it.
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const dist = resolve(import.meta.dirname, "../dist");
const entry = resolve(dist, "native.js");

// Constructs a bundler can see, which is narrower than "web-only APIs" on purpose. Metro
// follows `new Worker(new URL(...))`; unreachable web code costs bundle size and nothing.
const FORBIDDEN = ["new Worker", "import.meta.url"];

const seen = new Set();

/**
 * Comments are stripped first, and this is not a nicety: the files that matter here explain
 * at length why they do not touch AudioWorklet, and the raw text scan failed on that.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

async function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);

  const source = await readFile(file, "utf8");
  const code = stripComments(source);

  for (const term of FORBIDDEN) {
    if (code.includes(term)) {
      console.error(
        `${relative(dist, file)} reaches "${term}", which a bundler resolves ` +
          "whether or not the code runs.",
      );
      console.error(
        "Reachable from dist/native.js, so Metro will follow it and fail. Put " +
          "the call site behind a VoicePlatform method, the way " +
          "createNoiseSuppressor moved RNNoiseProcessor into platform/web.ts.",
      );
      process.exit(1);
    }
  }

  // Static imports and re-exports only. A dynamic import() would be worth
  // catching too, and there are none today — add it here if one appears.
  const specifiers = [...code.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1]);

  for (const specifier of specifiers) {
    await walk(resolve(dirname(file), specifier));
  }
}

await walk(entry);

console.log(
  `native entry ok: ${seen.size} file(s) reachable, no bundler-visible web-only references`,
);
