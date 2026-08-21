import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";

for (const flag of ["--yes", "--approve"]) {
  test(`CLI cannot supply inline approval with ${flag}`, async () => {
    await assert.rejects(
      runCli(["execute", flag]),
      /execute never accepts inline approval/,
    );
  });
}

test("CLI verifies a portable proof without replaying its contents", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "governed-action-cli-proof-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const output = join(directory, "result.json");
  assert.equal(
    await runCli([
      "verify-proof",
      "--proof",
      "docs/governed-action-proof.json",
      "--output",
      output,
    ]),
    0,
  );
  const result = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(Object.keys(result).sort(), ["mode", "packetDigest", "schemaVersion", "valid"]);
  assert.equal(result.valid, true);
  assert.equal(result.schemaVersion, "governed-action-proof/v1");
  assert.equal(result.mode, "synthetic_green_inspection");
  assert.match(result.packetDigest, /^[a-f0-9]{64}$/);
});

test("CLI rejects a tampered portable proof", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "governed-action-cli-proof-tamper-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const proof = JSON.parse(await readFile("docs/governed-action-proof.json", "utf8"));
  proof.receipt.result = "refused";
  const input = join(directory, "tampered.json");
  await writeFile(input, JSON.stringify(proof));
  await assert.rejects(runCli(["verify-proof", "--proof", input]), /receipt schema or digest|proof/i);
});
