import { readFile, writeFile } from "node:fs/promises";

import { build } from "esbuild";

const output = "docs/runtime.js";
const result = await build({
  entryPoints: ["src/browser-runtime.ts"],
  bundle: true,
  format: "esm",
  minify: true,
  platform: "browser",
  target: ["es2022"],
  write: false
});
const expected = new TextDecoder()
  .decode(result.outputFiles[0].contents)
  .replace(/[ \t]+$/gm, "")
  .replace(/\n*$/, "\n");

if (process.argv.includes("--check")) {
  const actual = await readFile(output, "utf8").catch(() => "");
  if (actual !== expected) {
    console.error(`${output} is stale; run npm run demo:sync`);
    process.exitCode = 1;
  } else {
    console.log("browser runtime is in sync");
  }
} else {
  await writeFile(output, expected);
  console.log(`built ${output}`);
}
