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
import { FileReceiptStore, MemoryReceiptStore, type ReceiptStore } from "../src/store.js";

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
    target: { adapterId: "governed-automation", resourceId: "site-refresh", environment: "synthetic_sandbox" },
    evidence: {
      diagnosticFormat: "context-layer-diagnostic/v1",
      diagnosticHash: "c".repeat(64),
      recordIds: ["site-refresh-receipt"],
      asOf: "2026-07-28T09:10:00Z",
    },
    expectedState: { contentHash: targetHash },
  };
}

async function setup(action = request(), receipts: ReceiptStore = new MemoryReceiptStore()) {
  const directory = await mkdtemp(join(tmpdir(), "governed-executor-"));
  const adapter = new SyntheticAutomationAdapter(directory);
  const approvals = new MemoryApprovalStore();
  const decision = evaluateAction(action, policy, evidence, clock);
  const loadCurrentState = async () => ({
    evidence,
    currentTargetHash: targetHash,
    diagnosticAsOf: "2026-07-28T09:10:00Z",
  });
  return { adapter, approvals, receipts, decision, loadCurrentState };
}

const receiptStoreFactories: Array<[string, () => Promise<ReceiptStore>]> = [
  ["memory", async () => new MemoryReceiptStore()],
  [
    "file",
    async () =>
      new FileReceiptStore(
        join(await mkdtemp(join(tmpdir(), "governed-receipts-")), "receipts.json"),
      ),
  ],
];

for (const [storeName, createStore] of receiptStoreFactories) {
  for (const classification of ["green", "yellow", "red"] as const) {
    test(`${storeName} idempotency rejects a different ${classification} action`, async () => {
      const first = request();
      if (first.action.type !== "retry_failed_lane") throw new Error("Expected retry action.");
      const receipts = await createStore();
      const state = await setup(first, receipts);
      await new OperatorApprovalProvider(state.approvals, clock).issue(first, state.decision, "operator", true);
      await executeGovernedAction(first, state.decision, { ...state, policy, evidence, clock });

      const base: ActionRequest = {
        ...first,
        id: "request-collision",
        intent: `A different ${classification} action using the same caller key`,
      };
      const collision: ActionRequest =
        classification === "green"
          ? {
              ...base,
              action: { type: "inspect_run_receipt", laneId: "site-refresh", recordId: "site-refresh-receipt" },
              target: { adapterId: "governed-automation", resourceId: "site-refresh", environment: "read_only" },
            }
          : classification === "red"
            ? {
                ...base,
                action: { type: "delete_preserved_output", laneId: "research-watch", recordId: "research-watch-receipt" },
                target: { adapterId: "governed-automation", resourceId: "research-watch", environment: "synthetic_sandbox" },
              }
            : { ...base, action: { ...first.action, retryPayloadHash: "e".repeat(64) } };
      const collisionDecision = evaluateAction(collision, policy, evidence, clock);
      if (classification === "yellow") {
        await new OperatorApprovalProvider(state.approvals, clock).issue(collision, collisionDecision, "operator", true);
      }

      await assert.rejects(
        executeGovernedAction(collision, collisionDecision, { ...state, policy, evidence, clock }),
        /already bound to another action/,
      );
      assert.equal(state.adapter.executeCalls, 1);
      assert.equal(state.approvals.consumed.size, 1);
      assert.equal((await receipts.list()).length, 1);
    });
  }
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

test("a signed decision remains executable after the clock advances", async () => {
  const action = request();
  const state = await setup(action);
  await new OperatorApprovalProvider(state.approvals, clock).issue(
    action,
    state.decision,
    "operator",
    true,
  );
  const laterClock = { now: () => new Date("2026-07-28T09:12:01Z") };

  const receipt = await executeGovernedAction(action, state.decision, {
    ...state,
    policy,
    evidence,
    clock: laterClock,
  });

  assert.equal(receipt.result, "succeeded");
  assert.equal(state.adapter.executeCalls, 1);
});

test("altered caller classification cannot select an execution path", async () => {
  const action = request();
  const state = await setup(action);
  const forged = {
    ...state.decision,
    classification: "green" as const,
    disposition: "allow" as const,
  };

  const receipt = await executeGovernedAction(action, forged, {
    ...state,
    policy,
    evidence,
    clock,
  });

  assert.equal(receipt.result, "stale");
  assert.equal(state.adapter.executeCalls, 0);
});

test("runtime adapter identity must match the authorized target", async () => {
  const action = request();
  const state = await setup(action);
  const adapter = Object.assign(Object.create(state.adapter), { id: "other-adapter" });

  const receipt = await executeGovernedAction(action, state.decision, {
    ...state,
    adapter,
    policy,
    evidence,
    clock,
  });

  assert.equal(receipt.result, "refused");
  assert.equal(receipt.preconditionCheck.passed, false);
  assert.equal(state.adapter.executeCalls, 0);
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

test("an effectful failed receipt is replayed without a second effect", async () => {
  const action = request("after_effect");
  const state = await setup(action);
  state.adapter.compensate = async () => ({
    passed: false,
    detail: "Forced compensation failure.",
  });
  await new OperatorApprovalProvider(state.approvals, clock).issue(action, state.decision, "operator", true);
  const dependencies = { ...state, policy, evidence, clock };

  const first = await executeGovernedAction(action, state.decision, dependencies);
  const replay = await executeGovernedAction(action, state.decision, dependencies);

  assert.equal(first.result, "failed");
  assert.equal(first.effects.length, 1);
  assert.equal(replay.id, first.id);
  assert.equal(state.adapter.executeCalls, 1);
});

test("a no-effect refusal releases the same action for an approved retry", async () => {
  const action = request();
  const state = await setup(action);
  const dependencies = { ...state, policy, evidence, clock };

  const refused = await executeGovernedAction(action, state.decision, dependencies);
  assert.equal(refused.result, "refused");
  assert.equal(refused.effects.length, 0);

  await new OperatorApprovalProvider(state.approvals, clock).issue(action, state.decision, "operator", true);
  const retried = await executeGovernedAction(action, state.decision, dependencies);
  assert.equal(retried.result, "succeeded");
  assert.equal(state.adapter.executeCalls, 1);
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
