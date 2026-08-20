import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildPublicDemo, recomputeImportedDecision } from "../src/browser-runtime.js";
import type { PolicyManifest } from "../src/contracts.js";

const diagnostic = JSON.parse(await readFile("examples/context-layer-diagnostic.json", "utf8"));
const diagnosticV2 = JSON.parse(
  await readFile("examples/context-layer-diagnostic-v2.json", "utf8"),
);
const policy = JSON.parse(await readFile("data/policy.json", "utf8")) as PolicyManifest;
const clock = { now: () => new Date("2026-07-28T09:10:00Z") };

test("browser builds all paths from shared core policy", () => {
  const demo = buildPublicDemo(diagnostic, policy, clock);
  assert.deepEqual(
    demo.map((item) => [item.decision.classification, item.decision.disposition]),
    [["green", "allow"], ["yellow", "approval_required"], ["red", "refuse"]],
  );
});

test("browser accepts the staged v2 diagnostic without changing the public default", () => {
  const demo = buildPublicDemo(diagnosticV2, policy, clock);
  assert.deepEqual(
    demo.map((item) => [item.decision.classification, item.decision.disposition]),
    [["green", "allow"], ["yellow", "approval_required"], ["red", "refuse"]],
  );
  assert.ok(
    demo.every(
      (item) =>
        item.request.evidence.diagnosticFormat ===
        "context-layer-diagnostic/v2",
    ),
  );
});

test("browser recomputes rather than trusting an imported decision", () => {
  const demo = buildPublicDemo(diagnostic, policy, clock)[1]!;
  const result = recomputeImportedDecision(
    {
      diagnostic,
      request: demo.request,
      decision: { ...demo.decision, decisionDigest: "a".repeat(64) },
    },
    policy,
    clock,
  );
  assert.equal(result.importedDecisionAccepted, false);
  assert.equal(result.decision.classification, "yellow");
});
