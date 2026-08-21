import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemoryApprovalStore, OperatorApprovalProvider } from "../src/approval.js";
import { SyntheticAutomationAdapter } from "../src/adapters/synthetic-automation.js";
import { policyManifestSchema, type ActionRequest } from "../src/contracts.js";
import { proposeActionFromDiagnostic } from "../src/context-adapter.js";
import { executeGovernedAction } from "../src/executor.js";
import { evaluateAction } from "../src/policy.js";
import { MemoryReceiptStore } from "../src/store.js";

const diagnostic = JSON.parse(
  await readFile("examples/context-layer-diagnostic-v2.json", "utf8"),
);
const policy = policyManifestSchema.parse(
  JSON.parse(await readFile("data/policy.json", "utf8")),
);
const clock = { now: () => new Date("2026-07-28T09:12:00Z") };

test("EXPECTED NON-DEFENSE: authorized read then synthetic-sink send can compose", async () => {
  const adapter = new SyntheticAutomationAdapter(
    await mkdtemp(join(tmpdir(), "governed-composition-")),
  );
  const receipts = new MemoryReceiptStore();
  const inspect = proposeActionFromDiagnostic(diagnostic, {
    actionType: "inspect_run_receipt",
    laneId: "site-refresh",
  });
  const inspectDecision = evaluateAction(inspect.request, policy, inspect.evidence, clock);
  const readReceipt = await executeGovernedAction(inspect.request, inspectDecision, {
    policy,
    evidence: inspect.evidence,
    loadCurrentState: async () => ({
      evidence: inspect.evidence,
      currentTargetHash: inspect.targetHash,
      diagnosticAsOf: inspect.diagnostic.scenario.asOf,
    }),
    adapter,
    approvals: null,
    receipts,
    verifiedPrincipal: inspect.request.proposer,
    clock,
  });
  assert.equal(readReceipt.result, "succeeded");
  assert.equal(readReceipt.effects[0]?.resourceId, "site-refresh");

  // The temporary retry record is the test-only synthetic sink analogue. There
  // is no communication adapter or network access in the production catalog.
  const retry = proposeActionFromDiagnostic(diagnostic, {
    actionType: "retry_failed_lane",
    laneId: "site-refresh",
  });
  if (retry.request.action.type !== "retry_failed_lane") {
    throw new Error("Expected retry action.");
  }
  const sendRequest: ActionRequest = {
    ...retry.request,
    action: {
      ...retry.request.action,
      retryPayloadHash: readReceipt.receiptDigest,
    },
  };
  const retryDecision = evaluateAction(sendRequest, policy, retry.evidence, clock);
  const approvals = new MemoryApprovalStore();
  await new OperatorApprovalProvider(approvals, clock).issue(
    sendRequest,
    retryDecision,
    "operator",
    true,
  );
  const sendReceipt = await executeGovernedAction(sendRequest, retryDecision, {
    policy,
    evidence: retry.evidence,
    loadCurrentState: async () => ({
      evidence: retry.evidence,
      currentTargetHash: retry.targetHash,
      diagnosticAsOf: retry.diagnostic.scenario.asOf,
    }),
    adapter,
    approvals,
    receipts,
    verifiedPrincipal: sendRequest.proposer,
    clock,
  });

  assert.equal(sendReceipt.result, "succeeded");
  assert.match(
    await readFile(adapter.retryPath, "utf8"),
    new RegExp(`"payloadHash": "${readReceipt.receiptDigest}"`),
  );
});
