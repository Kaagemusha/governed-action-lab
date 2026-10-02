// The README badges and the console's "what this proves" table state how many
// evals and named attacks pass. They are written by hand, so this check
// recounts them from the eval files and the attack list and fails on drift.
import { readFileSync } from "node:fs";

const cases = ["evals/action-cases.json", "evals/execution-cases.json"]
  .flatMap((path) => JSON.parse(readFileSync(path, "utf8")));
const count = (kind) => cases.filter((item) => item.kind === kind).length;
const total = cases.length;
const adversarial = count("adversarial");
const fault = count("fault");
const intended = count("intended");
if (adversarial + fault + intended !== total) throw new Error("An eval case has an unknown kind.");
const attacks = [...readFileSync("src/attack-demo.ts", "utf8").matchAll(/^\s*\["[A-Z_]+", "[A-Z]+", \w+\],?$/gm)].length;

const flat = (path) => readFileSync(path, "utf8").replace(/\s+/g, " ");
const expected = {
  "README.md": [
    `eval-${total}%2F${total}`,
    `attacks-${attacks}%2F${attacks}`,
    `${total} eval cases, ${adversarial} of them adversarial`,
    `The other ${total - adversarial} are ${fault} fault injections and ${intended} intended-path checks.`,
    `${attacks} named attacks, each mapped`,
  ],
  "docs/index.html": [
    `${total} of ${total} evaluations pass: ${adversarial} adversarial, ${fault} fault injection, ${intended} intended path.`,
    `${attacks} of ${attacks} named attacks held.`,
  ],
};
const missing = Object.entries(expected).flatMap(([path, phrases]) =>
  phrases.filter((phrase) => !flat(path).includes(phrase)).map((phrase) => `${path}: "${phrase}"`));
if (missing.length > 0) {
  console.error(`Public counts are out of date (${total} evals, ${attacks} attacks):\n${missing.join("\n")}`);
  process.exit(1);
}
console.log(`public counts match: ${total} evals (${adversarial} adversarial, ${fault} fault, ${intended} intended), ${attacks} named attacks`);
