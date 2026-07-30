import { readFile, writeFile } from "node:fs/promises";

const diagnostic = JSON.parse(await readFile("examples/context-layer-diagnostic.json", "utf8"));
const policy = JSON.parse(await readFile("data/policy.json", "utf8"));
const expected = `export const SAMPLE_DIAGNOSTIC = ${JSON.stringify(diagnostic, null, 2)};\n\nexport const PUBLIC_POLICY = ${JSON.stringify(policy, null, 2)};\n`;
const path = "docs/sample-data.js";

if (process.argv.includes("--check")) {
  const actual = await readFile(path, "utf8").catch(() => "");
  if (actual !== expected) {
    console.error(`${path} has drifted; run npm run demo:sync`);
    process.exitCode = 1;
  } else {
    console.log("public demo fixture is in sync");
  }
} else {
  await writeFile(path, expected);
  console.log(`built ${path}`);
}
