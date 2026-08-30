import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemoryApprovalStore, OperatorApprovalProvider } from "../src/approval.js";
import { SyntheticAutomationAdapter } from "../src/adapters/synthetic-automation.js";
import { sha256 } from "../src/canonical.js";
import {
  actionRequestSchema,
  type ActionRequest,
  type PolicyManifest,
} from "../src/contracts.js";
import {
  executeGovernedAction,
  IdempotencyStateError,
  PrincipalMismatchError,
} from "../src/executor.js";
import { actionDigest, evaluateAction } from "../src/policy.js";
import { FileReceiptStore, MemoryReceiptStore, type ClaimCheckpoint, type ReceiptStore } from "../src/store.js";

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
  return {
    adapter,
    approvals,
    receipts,
    decision,
    loadCurrentState,
    verifiedPrincipal: action.proposer,
  };
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

function leaveOrphanedFileClaim(input: {
  receiptPath: string;
  sandboxDirectory: string;
  action: ActionRequest;
  checkpoint: ClaimCheckpoint;
  applyEffect: boolean;
}): void {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { FileReceiptStore } from "./dist/src/store.js";
        import { SyntheticAutomationAdapter } from "./dist/src/adapters/synthetic-automation.js";
        const action = JSON.parse(process.env.GA_ACTION);
        const checkpoint = JSON.parse(process.env.GA_CHECKPOINT);
        const store = new FileReceiptStore(process.env.GA_RECEIPTS);
        const claim = await store.claim(action.idempotencyKey, checkpoint.approval.actionDigest);
        if (claim.status !== "claimed") throw new Error("Child could not acquire claim.");
        await store.checkpoint(action.idempotencyKey, checkpoint.approval.actionDigest, claim.claimId, checkpoint);
        if (process.env.GA_APPLY === "true") {
          await new SyntheticAutomationAdapter(process.env.GA_SANDBOX).execute(action);
        }
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GA_ACTION: JSON.stringify(input.action),
        GA_CHECKPOINT: JSON.stringify(input.checkpoint),
        GA_RECEIPTS: input.receiptPath,
        GA_SANDBOX: input.sandboxDirectory,
        GA_APPLY: String(input.applyEffect),
      },
      encoding: "utf8",
    },
  );
  assert.equal(child.status, 0, child.stderr);
}

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

test("verified principal mismatch is rejected before claims, approvals, or adapter calls", async () => {
  const action = request();
  const state = await setup(action);
  await new OperatorApprovalProvider(state.approvals, clock).issue(
    action,
    state.decision,
    "operator",
    true,
  );

  await assert.rejects(
    executeGovernedAction(action, state.decision, {
      ...state,
      policy,
      evidence,
      clock,
      verifiedPrincipal: { kind: "agent", id: "different-agent" },
    }),
    (error: unknown) =>
      error instanceof PrincipalMismatchError &&
      error.code === "PRINCIPAL_MISMATCH",
  );
  assert.equal(state.approvals.consumed.size, 0);
  assert.equal((await state.receipts.list()).length, 0);
  assert.equal(state.adapter.executeCalls, 0);

  const accepted = await executeGovernedAction(action, state.decision, {
    ...state,
    policy,
    evidence,
    clock,
  });
  assert.equal(accepted.result, "succeeded");
  assert.equal(state.adapter.executeCalls, 1);
});

test("post-approval action argument substitution has no executor effect", async () => {
  const action = request();
  const state = await setup(action);
  await new OperatorApprovalProvider(state.approvals, clock).issue(
    action,
    state.decision,
    "operator",
    true,
  );
  if (action.action.type !== "retry_failed_lane") {
    throw new Error("Expected retry action.");
  }
  const substituted: ActionRequest = {
    ...action,
    action: { ...action.action, retryPayloadHash: "f".repeat(64) },
  };
  const substitutedDecision = evaluateAction(substituted, policy, evidence, clock);

  const receipt = await executeGovernedAction(substituted, substitutedDecision, {
    ...state,
    policy,
    evidence,
    clock,
  });

  assert.equal(receipt.result, "refused");
  assert.match(receipt.preconditionCheck.detail, /missing/);
  assert.equal(receipt.effects.length, 0);
  assert.equal(state.approvals.consumed.size, 0);
  assert.equal(state.adapter.executeCalls, 0);
});

test("one raw payload has one strict normalized interpretation at every gate", async () => {
  const complete = request();
  if (complete.action.type !== "retry_failed_lane") {
    throw new Error("Expected retry action.");
  }
  const { simulateFailure: _omitted, ...actionWithoutDefault } = complete.action;
  const raw = { ...complete, action: actionWithoutDefault };
  const normalized = actionRequestSchema.parse(raw);
  const state = await setup(normalized);
  const decision = evaluateAction(raw, policy, evidence, clock);
  await new OperatorApprovalProvider(state.approvals, clock).issue(
    raw,
    decision,
    "operator",
    true,
  );
  let adapterRequest: ActionRequest | undefined;
  const execute = state.adapter.execute.bind(state.adapter);
  state.adapter.execute = async (candidate) => {
    adapterRequest = candidate;
    return execute(candidate);
  };

  const receipt = await executeGovernedAction(raw, decision, {
    ...state,
    policy,
    evidence,
    clock,
  });

  assert.equal(receipt.result, "succeeded");
  assert.equal(normalized.action.type, "retry_failed_lane");
  if (normalized.action.type === "retry_failed_lane") {
    assert.equal(normalized.action.simulateFailure, "none");
  }
  assert.equal(actionDigest(raw), actionDigest(normalized));
  assert.equal(decision.actionDigest, actionDigest(normalized));
  assert.deepEqual(adapterRequest, normalized);

  const unknown = { ...raw, unexpected: true };
  assert.throws(() => actionDigest(unknown));
  await assert.rejects(
    new OperatorApprovalProvider(new MemoryApprovalStore(), clock).issue(
      unknown,
      decision,
      "operator",
      true,
    ),
  );
  await assert.rejects(
    executeGovernedAction(unknown, decision, {
      ...state,
      approvals: new MemoryApprovalStore(),
      receipts: new MemoryReceiptStore(),
      policy,
      evidence,
      clock,
    }),
  );
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

for (const applyEffect of [false, true]) {
  test(`file store recovers a dead process ${applyEffect ? "after" : "before"} the synthetic effect`, async () => {
    const action = request();
    const receiptPath = join(
      await mkdtemp(join(tmpdir(), "governed-orphaned-receipts-")),
      "receipts.json",
    );
    const receipts = new FileReceiptStore(receiptPath);
    const state = await setup(action, receipts);
    const approval = await new OperatorApprovalProvider(state.approvals, clock).issue(
      action,
      state.decision,
      "operator",
      true,
    );
    const checkpoint: ClaimCheckpoint = {
      actionId: "action-orphaned",
      startedAt: "2026-07-28T09:12:00.000Z",
      approval,
      adapterState: await state.adapter.prepareRecovery(action),
    };
    leaveOrphanedFileClaim({
      receiptPath,
      sandboxDirectory: state.adapter.sandboxDirectory,
      action,
      checkpoint,
      applyEffect,
    });
    if (!applyEffect) {
      await writeFile(
        join(
          `${receiptPath}.idempotency`,
          `${sha256(action.idempotencyKey)}.recovering`,
        ),
        `${JSON.stringify({ ownerPid: 2_147_483_647 })}\n`,
      );
    }

    const receipt = await executeGovernedAction(action, state.decision, {
      ...state,
      policy,
      evidence,
      clock,
    });

    assert.equal(receipt.result, "succeeded");
    assert.equal(receipt.actionId, checkpoint.actionId);
    assert.equal(receipt.approvalId, approval.id);
    assert.equal(state.adapter.executeCalls, applyEffect ? 0 : 1);
    assert.equal(state.approvals.consumed.has(approval.id), true);
    const replay = await executeGovernedAction(action, state.decision, {
      ...state,
      policy,
      evidence,
      clock,
    });
    assert.equal(replay.id, receipt.id);
    assert.equal(state.adapter.executeCalls, applyEffect ? 0 : 1);
  });
}

test("orphan recovery preserves the claim when synthetic state is ambiguous", async () => {
  const action = request();
  const receiptPath = join(
    await mkdtemp(join(tmpdir(), "governed-ambiguous-receipts-")),
    "receipts.json",
  );
  const receipts = new FileReceiptStore(receiptPath);
  const state = await setup(action, receipts);
  const approval = await new OperatorApprovalProvider(state.approvals, clock).issue(
    action,
    state.decision,
    "operator",
    true,
  );
  const checkpoint: ClaimCheckpoint = {
    actionId: "action-ambiguous",
    startedAt: "2026-07-28T09:12:00.000Z",
    approval,
    adapterState: await state.adapter.prepareRecovery(action),
  };
  leaveOrphanedFileClaim({
    receiptPath,
    sandboxDirectory: state.adapter.sandboxDirectory,
    action,
    checkpoint,
    applyEffect: false,
  });
  await writeFile(state.adapter.retryPath, "foreign state\n");

  await assert.rejects(
    executeGovernedAction(action, state.decision, { ...state, policy, evidence, clock }),
    (error: unknown) =>
      error instanceof IdempotencyStateError &&
      error.code === "IDEMPOTENCY_RECOVERY_AMBIGUOUS",
  );
  await assert.rejects(
    executeGovernedAction(action, state.decision, { ...state, policy, evidence, clock }),
    (error: unknown) =>
      error instanceof IdempotencyStateError &&
      error.code === "IDEMPOTENCY_IN_PROGRESS",
  );
  assert.equal((await receipts.list()).length, 0);
  assert.equal(state.adapter.executeCalls, 0);
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

test("executor accepts a deterministic receipt ID factory without changing the random default", async () => {
  const base = request();
  const action: ActionRequest = {
    ...base,
    id: "request-green-id",
    idempotencyKey: "green-id-factory",
    action: { type: "inspect_run_receipt", laneId: "site-refresh", recordId: "site-refresh-receipt" },
    target: { adapterId: "governed-automation", resourceId: "site-refresh", environment: "read_only" },
  };
  const state = await setup(action);
  const receipt = await executeGovernedAction(action, state.decision, {
    ...state,
    policy,
    evidence,
    clock,
    receiptIdFactory: () => "receipt-injected-for-test",
  });
  assert.equal(receipt.id, "receipt-injected-for-test");
  assert.equal(receipt.result, "succeeded");

  const defaultAction = { ...action, idempotencyKey: "green-default-id" };
  const defaultState = await setup(defaultAction);
  const defaultReceipt = await executeGovernedAction(defaultAction, defaultState.decision, {
    ...defaultState,
    policy,
    evidence,
    clock,
  });
  assert.match(defaultReceipt.id, /^receipt-[0-9a-f-]{36}$/);
});

test("executor rechecks a digest-pinned host policy before executing", async () => {
  const action = request();
  const hostPolicy: PolicyManifest = {
    ...policy,
    id: "host-policy",
    version: "1",
    rules: policy.rules.map((rule) => ({
      ...rule,
      allowedResourceIds: ["site-refresh"],
    })),
  };
  const policyTrust = {
    id: hostPolicy.id,
    version: hostPolicy.version,
    manifestDigest: sha256(hostPolicy),
  };
  const state = await setup(action);
  const decision = evaluateAction(action, hostPolicy, evidence, clock, policyTrust);
  await new OperatorApprovalProvider(state.approvals, clock).issue(
    action,
    decision,
    "operator",
    true,
  );
  const receipt = await executeGovernedAction(action, decision, {
    ...state,
    policy: hostPolicy,
    policyTrust,
    evidence,
    clock,
  });
  assert.equal(receipt.result, "succeeded");
  assert.equal(state.adapter.executeCalls, 1);

  const replacedAction = {
    ...action,
    id: "request-host-policy-replaced",
    idempotencyKey: "host-policy-replaced",
  };
  const replacedPolicy = {
    ...hostPolicy,
    maxEvidenceAgeSeconds: hostPolicy.maxEvidenceAgeSeconds + 1,
  };
  const replacedTrust = {
    ...policyTrust,
    manifestDigest: sha256(replacedPolicy),
  };
  const replacedState = await setup(replacedAction);
  const originalDecision = evaluateAction(
    replacedAction,
    hostPolicy,
    evidence,
    clock,
    policyTrust,
  );
  const stale = await executeGovernedAction(replacedAction, originalDecision, {
    ...replacedState,
    policy: replacedPolicy,
    policyTrust: replacedTrust,
    evidence,
    clock,
  });
  assert.equal(stale.result, "stale");
  assert.equal(replacedState.adapter.executeCalls, 0);

  const omittedAction = {
    ...action,
    id: "request-host-policy-without-trust",
    idempotencyKey: "host-policy-without-trust",
  };
  const omittedState = await setup(omittedAction);
  const omittedDecision = evaluateAction(
    omittedAction,
    hostPolicy,
    evidence,
    clock,
    policyTrust,
  );
  const refused = await executeGovernedAction(omittedAction, omittedDecision, {
    ...omittedState,
    policy: hostPolicy,
    evidence,
    clock,
  });
  assert.equal(refused.result, "refused");
  assert.equal(omittedState.adapter.executeCalls, 0);
});
