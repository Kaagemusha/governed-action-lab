import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildPublicDemo,
  buildSyntheticBrowserReceipt,
  recomputeImportedDecision,
} from "../src/browser-runtime.js";
import {
  executionReceiptSchema,
  type PolicyManifest,
} from "../src/contracts.js";
import { verifyReceipt } from "../src/receipts.js";

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

test("browser uses the promoted v2 diagnostic", () => {
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

test("browser exports strict verifiable green and yellow receipts", () => {
  const demo = buildPublicDemo(diagnostic, policy, clock);
  const read = buildSyntheticBrowserReceipt(demo[0]!, "read");
  const retry = buildSyntheticBrowserReceipt(demo[1]!, "retry");

  for (const receipt of [read, retry]) {
    assert.equal(executionReceiptSchema.safeParse(receipt).success, true);
    assert.deepEqual(verifyReceipt(receipt), {
      valid: true,
      detail: "Receipt schema and digest verify.",
    });
    assert.equal(receipt.preconditionCheck.passed, true);
    assert.equal(receipt.previousReceiptId, null);
    assert.match(receipt.actionId, /^browser-action-/);
    assert.equal(receipt.parentActionId, undefined);
    assert.equal("note" in receipt, false);
  }
  assert.equal(read.approvalId, null);
  assert.equal(read.effects[0]?.beforeHash, read.effects[0]?.afterHash);
  assert.match(retry.approvalId ?? "", /^browser-synthetic-approval-/);
  assert.equal(retry.compensation.supported, true);
  assert.notEqual(retry.effects[0]?.beforeHash, retry.effects[0]?.afterHash);
  assert.equal(
    verifyReceipt({ ...retry, result: "failed" }).valid,
    false,
  );
});

test("browser receipt builder refuses mismatched governed paths", () => {
  const demo = buildPublicDemo(diagnostic, policy, clock);
  assert.throws(
    () => buildSyntheticBrowserReceipt(demo[0]!, "retry"),
    /does not match the governed action/,
  );
  assert.throws(
    () => buildSyntheticBrowserReceipt(demo[2]!, "read"),
    /does not match the governed action/,
  );
});
