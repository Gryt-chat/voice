// Asserts no two files reachable from an entry point declare the same exported name. An
// explicit export beats a star export silently, which is what GRYT-433 was.
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const dist = resolve(import.meta.dirname, "../dist");

// Declarations, not re-exports. A name declared once and passed through five
// barrels is one declaration; that is the normal case and must not trip this.
const DECLARATION =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:interface|type|class|function|const|let|var|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm;

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** dist emits `from "./engine.js"` in the .d.ts too, so map back to the types. */
function typesFor(specifier, from) {
  return resolve(dirname(from), specifier.replace(/\.js$/, ".d.ts"));
}

async function walk(file, declarations, seen) {
  if (seen.has(file)) return;
  seen.add(file);

  const code = stripComments(await readFile(file, "utf8"));

  for (const [, name] of code.matchAll(DECLARATION)) {
    const where = declarations.get(name) ?? new Set();
    where.add(relative(dist, file));
    declarations.set(name, where);
  }

  for (const [, specifier] of code.matchAll(/from\s+"(\.[^"]+)"/g)) {
    await walk(typesFor(specifier, file), declarations, seen);
  }
}

let failed = false;

for (const entry of ["index.d.ts", "native.d.ts"]) {
  const declarations = new Map();
  const seen = new Set();
  await walk(resolve(dist, entry), declarations, seen);

  const clashes = [...declarations].filter(([, where]) => where.size > 1);

  if (clashes.length > 0) {
    failed = true;
    console.error(`${entry} reaches ${clashes.length} name(s) declared twice:`);
    for (const [name, where] of clashes) {
      console.error(`  ${name}: ${[...where].join(", ")}`);
    }
    console.error(
      "One of them wins at the root and the other becomes unnameable from " +
        "outside the package. Rename one — the hook return types took a State " +
        "suffix for this reason.",
    );
  } else {
    console.log(
      `type names ok: ${entry} reaches ${seen.size} file(s), ${declarations.size} declared name(s), no duplicates`,
    );
  }
}

if (failed) process.exit(1);
