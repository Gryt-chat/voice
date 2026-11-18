// Every source the helper build compiles has to ship in the package, or the app can't build from npm.
import { readFileSync } from "node:fs";

const files: string[] = JSON.parse(readFileSync("package.json", "utf8")).files;
const build = readFileSync("native/tools/build-helper.mjs", "utf8");
const named = [...build.matchAll(/join\(root, "([^"]+)"\)/g)].map((m) => m[1]);
const shipped = (path: string) => files.some((f) => path === f || path.startsWith(`${f}/`));

const missing = named.filter((p) => !shipped(p));
const headers = [...readFileSync("native/tools/voice_helper.c", "utf8").matchAll(/#include "([^"/]+\.h)"/g)]
  .map((m) => `native/tools/${m[1]}`)
  .filter((p) => !shipped(p));

if (named.length === 0) {
  console.error("check-helper-packaged: found no join(root, ...) paths in build-helper.mjs; the pattern needs updating");
  process.exit(1);
}
if (missing.length || headers.length) {
  console.error(`check-helper-packaged: not in package.json "files": ${[...missing, ...headers].join(", ")}`);
  process.exit(1);
}
console.log(`helper packaging: all ${named.length} sources and their headers ship`);
