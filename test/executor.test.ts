import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemoryApprovalStore, OperatorApprovalProvider } from "../src/approval.js";
import { SyntheticAutomationAdapter } from "../src/adapters/synthetic-automation.js";
import type { ActionRequest, PolicyManifest } from "../src/contracts.js";
import { executeGovernedAction } from "../src/executor.js";
import { evaluateAction } from "../src/policy.js";
import { MemoryReceiptStore } from "../src/store.js";

const policy = JSON.parse(await readFile("data/policy.json", "utf8")) as PolicyManifest;
const targetHash = "a".repeat(64);
const evidence = {
  presentRecordIds: ["site-refresh-receipt"],
  qualityByRecordId: { "site-refresh-receipt": "valid" as const },
  outcome: "failed" as const,
  assessmentMatchesRawEvidence: true,
};
const clock = { now: () => new Date("2026-07-28T09:12:00Z") };

function request(failure: "none" | "before_effect" | "after_effect" = "none"): ActionRequest {
  return {
    schemaVersion: "governed-action-request/v1",
    id: "request-retry",
    idempotencyKey: "retry-once",
    proposedAt: "2026-07-28T09:11:00Z",
    proposer: { kind: "agent", id: "demo" },
    intent: "Retry the failed lane",
    action: {
      type: "retry_failed_lane",
      laneId: "site-refresh",
      recordId: "site-refresh-receipt",
      retryPayloadHash: "b".repeat(64),
      simulateFailure: failure,
    },
    target: { adapterId: "synthetic-automation", resourceId: "site-refresh", environment: "synthetic_sandbox" },
    evidence: {
      diagnosticFormat: "context-layer-diagnostic/v1",
      diagnosticHash: "c".repeat(64),
      recordIds: ["site-refresh-receipt"],
      asOf: "2026-07-28T09:10:00Z",
    },
    expectedState: { contentHash: targetHash },
  };
}

async function setup(action = request()) {
  const directory = await mkdtemp(join(tmpdir(), "governed-executor-"));
  const adapter = new SyntheticAutomationAdapter(directory);
  const approvals = new MemoryApprovalStore();
  const receipts = new MemoryReceiptStore();
  const decision = evaluateAction(action, policy, evidence, clock);
  const loadCurrentState = async () => ({
    evidence,
    currentTargetHash: targetHash,
    diagnosticAsOf: "2026-07-28T09:10:00Z",
  });
  return { adapter, approvals, receipts, decision, loadCurrentState };
}

test("yellow executes once with exact approval and verifies effect", async () => {
  const action = request();
  const state = await setup(action);
  await new OperatorApprovalProvider(state.approvals, clock).issue(action, state.decision, "operator", true);
  const dependencies = { ...state, policy, evidence, clock };
  const first = await executeGovernedAction(action, state.decision, dependencies);
  const second = await executeGovernedAction(action, state.decision, dependencies);
  assert.equal(first.result, "succeeded");
  assert.equal(first.verification.passed, true);
  assert.equal(second.id, first.id);
  assert.equal(state.adapter.executeCalls, 1);
});

test("missing approval, stale evidence, and changed target produce receipts without effects", async () => {
  const action = request();
  const state = await setup(action);
  const missing = await executeGovernedAction(action, state.decision, { ...state, policy, evidence, clock, approvals: null });
  assert.equal(missing.result, "refused");
  assert.equal(missing.effects.length, 0);

  const staleStore = new MemoryReceiptStore();
  const stale = await executeGovernedAction(action, state.decision, {
    ...state,
    policy,
    evidence,
    clock: { now: () => new Date("2026-07-30T09:12:00Z") },
    receipts: staleStore,
  });
  assert.equal(stale.result, "stale");

  const changed = await executeGovernedAction(action, state.decision, {
    ...state,
    policy,
    evidence,
    clock,
    receipts: new MemoryReceiptStore(),
    loadCurrentState: async () => ({ evidence, currentTargetHash: "d".repeat(64), diagnosticAsOf: "2026-07-28T09:10:00Z" }),
  });
  assert.equal(changed.result, "stale");
});

test("partial failure uses pre-authorized compensation", async () => {
  const action = request("after_effect");
  const state = await setup(action);
  await new OperatorApprovalProvider(state.approvals, clock).issue(action, state.decision, "operator", true);
  const receipt = await executeGovernedAction(action, state.decision, { ...state, policy, evidence, clock });
  assert.equal(receipt.result, "compensated");
  assert.equal(receipt.compensation.result, "succeeded");
  assert.equal(await readFile(state.adapter.retryPath, "utf8"), "");
});

test("verification failure uses pre-authorized compensation", async () => {
  const action = request();
  const state = await setup(action);
  await new OperatorApprovalProvider(state.approvals, clock).issue(
    action,
    state.decision,
    "operator",
    true,
  );
  state.adapter.verify = async () => ({
    passed: false,
    detail: "Forced verification mismatch.",
  });
  const receipt = await executeGovernedAction(action, state.decision, {
    ...state,
    policy,
    evidence,
    clock,
  });
  assert.equal(receipt.result, "compensated");
  assert.equal(receipt.compensation.result, "succeeded");
  assert.equal(await readFile(state.adapter.retryPath, "utf8"), "");
});
