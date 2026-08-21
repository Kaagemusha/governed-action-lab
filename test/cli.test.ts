import assert from "node:assert/strict";
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
