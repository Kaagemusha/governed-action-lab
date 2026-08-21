import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryApprovalStore, OperatorApprovalProvider } from "./approval.js";
import { SyntheticAutomationAdapter } from "./adapters/synthetic-automation.js";
import {
  actionRequestSchema,
  diagnosticSnapshotSchema,
  policyManifestSchema,
} from "./contracts.js";
import { proposeActionFromDiagnostic } from "./context-adapter.js";
import {
  executeGovernedAction,
  PrincipalMismatchError,
  type ExecutorDependencies,
} from "./executor.js";
import { evaluateAction } from "./policy.js";
import { verifyReceipt } from "./receipts.js";
import { MemoryReceiptStore } from "./store.js";

const diagnostic = diagnosticSnapshotSchema.parse(
  JSON.parse(await readFile("examples/context-layer-diagnostic-v2.json", "utf8")),
);
const policy = policyManifestSchema.parse(
  JSON.parse(await readFile("data/policy.json", "utf8")),
);
const executionClock = {
  now: () => new Date(new Date(diagnostic.scenario.asOf).getTime() + 2 * 60 * 1000),
};

type RetrySetup = Awaited<ReturnType<typeof retrySetup>>;

async function retrySetup(root: string, caseId: string) {
  const proposal = proposeActionFromDiagnostic(diagnostic, {
    actionType: "retry_failed_lane",
    laneId: "site-refresh",
  });
  const adapter = new SyntheticAutomationAdapter(join(root, caseId));
  const approvals = new MemoryApprovalStore();
  const receipts = new MemoryReceiptStore();
  const decision = evaluateAction(
    proposal.request,
    policy,
    proposal.evidence,
    executionClock,
  );
  return { ...proposal, adapter, approvals, receipts, decision, caseId };
}

function dependencies(
  setup: RetrySetup,
  overrides: Partial<ExecutorDependencies> = {},
): ExecutorDependencies {
  return {
    policy,
    evidence: setup.evidence,
    loadCurrentState: async () => ({
      evidence: setup.evidence,
      currentTargetHash: setup.targetHash,
      diagnosticAsOf: setup.diagnostic.scenario.asOf,
    }),
    adapter: setup.adapter,
    approvals: setup.approvals,
    receipts: setup.receipts,
    verifiedPrincipal: setup.request.proposer,
    clock: executionClock,
    receiptIdFactory: () => `receipt-${setup.caseId}`,
    ...overrides,
  };
}

async function issueApproval(setup: RetrySetup) {
  await new OperatorApprovalProvider(setup.approvals, executionClock).issue(
    setup.request,
    setup.decision,
    "synthetic-operator",
    true,
  );
}

async function argumentSubstitution(root: string): Promise<boolean> {
  const setup = await retrySetup(root, "argument-substitution");
  await issueApproval(setup);
  if (setup.request.action.type !== "retry_failed_lane") return false;
  const substituted = actionRequestSchema.parse({
    ...setup.request,
    action: {
      ...setup.request.action,
      retryPayloadHash: "f".repeat(64),
    },
  });
  const substitutedDecision = evaluateAction(
    substituted,
    policy,
    setup.evidence,
    executionClock,
  );
  const receipt = await executeGovernedAction(
    substituted,
    substitutedDecision,
    dependencies(setup),
  );
  return (
    receipt.result === "refused" &&
    receipt.effects.length === 0 &&
    setup.adapter.executeCalls === 0 &&
    setup.approvals.consumed.size === 0
  );
}

async function approvalReplay(root: string): Promise<boolean> {
  const setup = await retrySetup(root, "approval-replay");
  await issueApproval(setup);
  const first = await executeGovernedAction(
    setup.request,
    setup.decision,
    dependencies(setup),
  );
  const replay = await executeGovernedAction(
    setup.request,
    setup.decision,
    dependencies(setup, {
      receipts: new MemoryReceiptStore(),
      receiptIdFactory: () => "receipt-approval-replay-denied",
    }),
  );
  return (
    first.result === "succeeded" &&
    replay.result === "refused" &&
    replay.preconditionCheck.detail.includes("replayed") &&
    replay.effects.length === 0 &&
    setup.adapter.executeCalls === 1
  );
}

async function confusedDeputy(root: string): Promise<boolean> {
  const setup = await retrySetup(root, "confused-deputy");
  await issueApproval(setup);
  let denied = false;
  try {
    await executeGovernedAction(
      setup.request,
      setup.decision,
      dependencies(setup, {
        verifiedPrincipal: { kind: "agent", id: "different-synthetic-agent" },
      }),
    );
  } catch (error) {
    denied =
      error instanceof PrincipalMismatchError &&
      error.code === "PRINCIPAL_MISMATCH";
  }
  return (
    denied &&
    setup.approvals.consumed.size === 0 &&
    (await setup.receipts.list()).length === 0 &&
    setup.adapter.executeCalls === 0
  );
}

async function changedState(root: string): Promise<boolean> {
  const setup = await retrySetup(root, "changed-state");
  await issueApproval(setup);
  const receipt = await executeGovernedAction(
    setup.request,
    setup.decision,
    dependencies(setup, {
      loadCurrentState: async () => ({
        evidence: setup.evidence,
        currentTargetHash: "d".repeat(64),
        diagnosticAsOf: setup.diagnostic.scenario.asOf,
      }),
    }),
  );
  return (
    receipt.result === "stale" &&
    receipt.effects.length === 0 &&
    setup.adapter.executeCalls === 0
  );
}

async function receiptTampering(root: string): Promise<boolean> {
  const proposal = proposeActionFromDiagnostic(diagnostic, {
    actionType: "inspect_run_receipt",
    laneId: "site-refresh",
  });
  const adapter = new SyntheticAutomationAdapter(join(root, "receipt-tampering"));
  const decision = evaluateAction(
    proposal.request,
    policy,
    proposal.evidence,
    executionClock,
  );
  const receipt = await executeGovernedAction(proposal.request, decision, {
    policy,
    evidence: proposal.evidence,
    loadCurrentState: async () => ({
      evidence: proposal.evidence,
      currentTargetHash: proposal.targetHash,
      diagnosticAsOf: proposal.diagnostic.scenario.asOf,
    }),
    adapter,
    approvals: null,
    receipts: new MemoryReceiptStore(),
    verifiedPrincipal: proposal.request.proposer,
    clock: executionClock,
    receiptIdFactory: () => "receipt-content-tampering",
  });
  return (
    verifyReceipt(receipt).valid &&
    !verifyReceipt({ ...receipt, result: "failed" }).valid
  );
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "governed-attack-demo-"));
  const cases = [
    ["ARGUMENT_SUBSTITUTION", "DENIED", argumentSubstitution],
    ["APPROVAL_REPLAY", "DENIED", approvalReplay],
    ["CONFUSED_DEPUTY", "DENIED", confusedDeputy],
    ["TOCTOU_CHANGED_STATE", "DENIED", changedState],
    ["RECEIPT_CONTENT_TAMPERING", "DETECTED", receiptTampering],
  ] as const;
  let passed = 0;
  try {
    for (const [label, expected, run] of cases) {
      let held = false;
      try {
        held = await run(root);
      } catch {
        held = false;
      }
      process.stdout.write(`${label}: ${held ? expected : "FAILED"}\n`);
      if (held) passed += 1;
    }
    process.stdout.write(`${passed}/${cases.length} expected defenses held\n`);
    if (passed !== cases.length) process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true });
  }
}

main().catch(() => {
  process.stderr.write("Attack demo failed unexpectedly.\n");
  process.exitCode = 1;
});
