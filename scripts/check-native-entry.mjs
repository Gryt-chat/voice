// Asserts the React Native entry point cannot reach the web-only code.
//
// `@gryt/voice/native` exists so a phone bundle contains no AudioContext, no
// AudioWorklet and no Worker. Nothing enforces that except which files import
// which, and an import added for one convenient helper would undo it silently:
// the package would still build, still typecheck, still publish, and Metro
// would fail on `new URL("./rnnoiseWorker.js", import.meta.url)` — at parse
// time, in the app, with a stack pointing at a bundler rather than at the
// import that caused it.
//
// So this walks the actual import graph of dist/native.js and looks at what
// ends up in it. Same idea as check-public-surface.mjs: the compiler is not
// going to tell us, so a list does.
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const dist = resolve(import.meta.dirname, "../dist");
const entry = resolve(dist, "native.js");

// Constructs a *bundler* can see, which is a narrower list than "web-only
// APIs" and deliberately so.
//
// The native entry re-exports the whole engine, so plenty of Web Audio and DOM
// code is reachable from here — `microphonePipeline`, `useAudioContext`,
// `useCamera`. None of it runs on a phone: `useMicrophone` branches on the
// platform supplying its own pipeline and never activates an AudioContext.
// Unreachable-at-runtime code costs bundle size and nothing else.
//
// What actually breaks a build is a reference a bundler resolves whether or
// not the code runs. Metro treats `new Worker(new URL(...))` as a dependency
// and follows it; that one construct, in rnnoiseProcessor, is what kept the
// engine off React Native. `import.meta.url` is here as its travelling
// companion rather than because Metro rejects it — measured, it parses fine.
//
// So this checks what it can actually promise: the bundle resolves. It does
// not promise the engine avoids web APIs on a phone. The platform branch in
// useMicrophone promises that, and only a device can confirm it.
const FORBIDDEN = ["new Worker", "import.meta.url"];

const seen = new Set();

/**
 * Comments are stripped first, and this is not a nicety.
 *
 * The files that matter here are the ones explaining at length why they do not
 * touch AudioWorklet — so scanning the raw text fails on the comment saying the
 * code is correct. It did, on this script's first run.
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
