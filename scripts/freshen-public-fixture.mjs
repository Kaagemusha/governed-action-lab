import { readFile, writeFile } from "node:fs/promises";

import { freshenPublicFixture } from "../dist/src/fresh-fixture.js";

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      result[value.slice(2)] = next;
      index += 1;
    }
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
if (!args.output) throw new Error("--output is required.");
const target = args.at ? new Date(args.at) : new Date();
const fixture = JSON.parse(await readFile("examples/context-layer-diagnostic-v2.json", "utf8"));
const fresh = freshenPublicFixture(fixture, target);
await writeFile(args.output, `${JSON.stringify(fresh, null, 2)}\n`);
process.stdout.write(`Fresh synthetic diagnostic: ${args.output}\nAs of: ${fresh.scenario.asOf}\n`);
