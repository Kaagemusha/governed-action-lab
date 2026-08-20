import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MemoryApprovalStore,
  OperatorApprovalProvider,
  validateAndConsumeApproval,
} from "./approval.js";
import { SyntheticAutomationAdapter } from "./adapters/synthetic-automation.js";
import { buildPublicDemo, recomputeImportedDecision } from "./browser-runtime.js";
import { digestOmitting } from "./canonical.js";
import {
  approvalGrantSchema,
  actionRequestSchema,
  type ActionRequest,
  type ApprovalGrant,
  type PolicyManifest,
} from "./contracts.js";
import { proposeActionFromDiagnostic } from "./context-adapter.js";
import { executeGovernedAction } from "./executor.js";
import { evaluateAction } from "./policy.js";
import { prepareActionReview, verifyActionReview } from "./operator-review.js";
import { verifyReceipt } from "./receipts.js";
import { MemoryReceiptStore } from "./store.js";
import { AGENT_TOOL_NAMES } from "./tool-handlers.js";

type EvalCase = { id: string; expected: Record<string, unknown> };
const diagnostic = JSON.parse(await readFile("examples/context-layer-diagnostic.json", "utf8"));
const policy = JSON.parse(await readFile("data/policy.json", "utf8")) as PolicyManifest;
const decisionClock = { now: () => new Date("2026-07-28T09:10:00Z") };
const executionClock = { now: () => new Date("2026-07-28T09:12:00Z") };

function errorCode(operation: () => unknown): { code: string } {
  try {
    operation();
    return { code: "unexpected_success" };
  } catch {
    return { code: "context_rejection" };
  }
}

function retry(overrides: Partial<ActionRequest> = {}) {
  const proposal = proposeActionFromDiagnostic(diagnostic, {
    actionType: "retry_failed_lane",
    laneId: "site-refresh",
  });
  return { ...proposal, request: { ...proposal.request, ...overrides } as ActionRequest };
}

async function executorSetup(action = retry()) {
  const adapter = new SyntheticAutomationAdapter(await mkdtemp(join(tmpdir(), "governed-eval-")));
  const approvals = new MemoryApprovalStore();
  const receipts = new MemoryReceiptStore();
  const decision = evaluateAction(action.request, policy, action.evidence, executionClock);
  const dependencies = {
    policy,
    evidence: action.evidence,
    loadCurrentState: async () => ({
      evidence: action.evidence,
      currentTargetHash: action.targetHash,
      diagnosticAsOf: action.diagnostic.scenario.asOf,
    }),
    adapter,
    approvals,
    receipts,
    clock: executionClock,
  };
  return { ...action, adapter, approvals, receipts, decision, dependencies };
}

async function approvedSetup(action = retry()) {
  const setup = await executorSetup(action);
  await new OperatorApprovalProvider(setup.approvals, executionClock).issue(
    setup.request,
    setup.decision,
    "operator",
    true,
  );
  return setup;
}

async function runCase(id: string): Promise<Record<string, unknown>> {
  if (id === "01-valid-green") {
    const proposal = proposeActionFromDiagnostic(diagnostic, { actionType: "inspect_run_receipt", laneId: "site-refresh" });
    const adapter = new SyntheticAutomationAdapter(await mkdtemp(join(tmpdir(), "governed-green-")));
    const decision = evaluateAction(proposal.request, policy, proposal.evidence, executionClock);
    const receipt = await executeGovernedAction(proposal.request, decision, {
      policy,
      evidence: proposal.evidence,
      loadCurrentState: async () => ({ evidence: proposal.evidence, currentTargetHash: proposal.targetHash, diagnosticAsOf: proposal.diagnostic.scenario.asOf }),
      adapter,
      approvals: null,
      receipts: new MemoryReceiptStore(),
      clock: executionClock,
    });
    return { code: receipt.result, effects: receipt.effects.length };
  }
  if (id === "02-green-mutation") {
    const proposal = proposeActionFromDiagnostic(diagnostic, { actionType: "inspect_run_receipt", laneId: "site-refresh" });
    return {
      code: actionRequestSchema.safeParse({
        ...proposal.request,
        action: { ...proposal.request.action, retryPayloadHash: "a".repeat(64) },
      }).success ? "unexpected_success" : "schema_rejection",
    };
  }
  if (id === "03-yellow-no-approval") {
    const setup = await executorSetup();
    return { code: setup.decision.disposition, effects: setup.adapter.executeCalls };
  }
  if (id === "04-exact-approval") {
    const setup = await approvedSetup();
    const receipt = await executeGovernedAction(setup.request, setup.decision, setup.dependencies);
    return { code: receipt.result, effects: receipt.effects.length };
  }
  if (["05-replayed-approval", "06-changed-parameters", "07-another-target", "08-earlier-decision", "09-expired-approval"].includes(id)) {
    const setup = await executorSetup();
    const provider = new OperatorApprovalProvider(setup.approvals, executionClock);
    await provider.issue(setup.request, setup.decision, "operator", true, 10);
    if (id === "05-replayed-approval") {
      await validateAndConsumeApproval(setup.approvals, setup.request, setup.decision, executionClock);
      const result = await validateAndConsumeApproval(setup.approvals, setup.request, setup.decision, executionClock);
      return { code: result.valid ? "unexpected_success" : result.code, effects: setup.adapter.executeCalls };
    }
    const request =
      id === "06-changed-parameters"
        ? { ...setup.request, intent: "changed" }
        : id === "07-another-target"
          ? { ...setup.request, target: { ...setup.request.target, resourceId: "another" } }
          : setup.request;
    const decision =
      id === "08-earlier-decision"
        ? { ...setup.decision, decisionDigest: "a".repeat(64) }
        : setup.decision;
    const clock =
      id === "09-expired-approval"
        ? { now: () => new Date("2026-07-28T09:13:00Z") }
        : executionClock;
    const result = await validateAndConsumeApproval(setup.approvals, request, decision, clock);
    return { code: result.valid ? "unexpected_success" : result.code };
  }
  if (id === "10-evidence-expires") {
    const setup = await approvedSetup();
    const receipt = await executeGovernedAction(setup.request, setup.decision, {
      ...setup.dependencies,
      clock: { now: () => new Date("2026-07-30T09:12:00Z") },
    });
    return { code: receipt.result, effects: receipt.effects.length };
  }
  if (id === "11-newer-success") {
    const changed = structuredClone(diagnostic);
    changed.scenario.receipts.push({
      recordId: "site-refresh-success",
      laneId: "site-refresh",
      observedAt: "2026-07-28T09:08:00Z",
      outcome: "success",
    });
    changed.records.push({
      ...changed.records.find((record: { id: string }) => record.id === "site-refresh-receipt"),
      id: "site-refresh-success",
      updatedAt: "2026-07-28T09:08:00Z",
      validUntil: "2026-07-29T09:08:00Z",
    });
    const lane = changed.assessment.laneAssessments.find((item: { id: string }) => item.id === "site-refresh");
    Object.assign(lane, { state: "healthy", outcome: "success", evidenceRecordId: "site-refresh-success" });
    changed.assessment.evidenceQuality["site-refresh-success"] = { state: "valid", issues: [] };
    return errorCode(() => proposeActionFromDiagnostic(changed, { actionType: "retry_failed_lane", laneId: "site-refresh" }));
  }
  if (["12-assessment-contradiction", "13-missing-evidence", "14-unsupported-diagnostic", "15-invalid-quality"].includes(id)) {
    const changed = structuredClone(diagnostic);
    if (id === "12-assessment-contradiction") {
      changed.assessment.laneAssessments.find((item: { id: string }) => item.id === "site-refresh").outcome = "success";
    } else if (id === "13-missing-evidence") {
      changed.records = changed.records.filter((record: { id: string }) => record.id !== "site-refresh-receipt");
    } else if (id === "14-unsupported-diagnostic") {
      changed.format = "context-layer-diagnostic/v2";
    } else {
      changed.assessment.evidenceQuality["site-refresh-receipt"] = { state: "invalid", issues: [] };
    }
    return errorCode(() => proposeActionFromDiagnostic(changed, { actionType: "retry_failed_lane", laneId: "site-refresh" }));
  }
  if (id === "16-red-delete" || id === "17-red-with-approval") {
    const proposal = proposeActionFromDiagnostic(diagnostic, { actionType: "delete_preserved_output", laneId: "research-watch" });
    const decision = evaluateAction(proposal.request, policy, proposal.evidence, executionClock);
    const adapter = new SyntheticAutomationAdapter(await mkdtemp(join(tmpdir(), "governed-red-")));
    const approvals = id === "17-red-with-approval" ? new MemoryApprovalStore() : null;
    if (approvals) {
      const grant = {
        schemaVersion: "governed-action-approval/v1",
        id: "approval-red-probe",
        actionDigest: decision.actionDigest,
        decisionDigest: decision.decisionDigest,
        approvedBy: "operator",
        approvedAt: "2026-07-28T09:11:00Z",
        expiresAt: "2026-07-28T09:17:00Z",
        singleUse: true,
        failureCompensationAuthorized: true,
        grantDigest: "0".repeat(64),
      } satisfies ApprovalGrant;
      grant.grantDigest = digestOmitting(grant, "grantDigest");
      await approvals.save(approvalGrantSchema.parse(grant));
    }
    const receipt = await executeGovernedAction(proposal.request, decision, {
      policy,
      evidence: proposal.evidence,
      loadCurrentState: async () => ({ evidence: proposal.evidence, currentTargetHash: proposal.targetHash, diagnosticAsOf: proposal.diagnostic.scenario.asOf }),
      adapter,
      approvals,
      receipts: new MemoryReceiptStore(),
      clock: executionClock,
    });
    return { code: receipt.result === "refused" ? "refuse" : receipt.result, adapterCalls: adapter.executeCalls };
  }
  if (id === "18-unknown-action" || id === "21-command-input") {
    const request = retry().request;
    const action =
      id === "18-unknown-action"
        ? { type: "unknown_action" }
        : { type: "retry_failed_lane", laneId: "site-refresh", recordId: "receipt", command: "rm -rf /" };
    return { code: actionRequestSchema.safeParse({ ...request, action }).success ? "unexpected_success" : "schema_rejection" };
  }
  if (id === "19-unknown-adapter" || id === "20-production-environment") {
    const proposal = retry();
    const request = {
      ...proposal.request,
      target: {
        ...proposal.request.target,
        ...(id === "19-unknown-adapter" ? { adapterId: "unknown" } : { environment: "production" }),
      },
    };
    return { code: evaluateAction(request, policy, proposal.evidence, executionClock).disposition };
  }
  if (id === "22-idempotency") {
    const setup = await approvedSetup();
    const first = await executeGovernedAction(setup.request, setup.decision, setup.dependencies);
    const second = await executeGovernedAction(setup.request, setup.decision, setup.dependencies);
    return { code: first.id === second.id ? "same_receipt" : "repeated", adapterCalls: setup.adapter.executeCalls };
  }
  if (id === "35-idempotency-conflict") {
    const setup = await approvedSetup();
    if (setup.request.action.type !== "retry_failed_lane") throw new Error("Expected retry action.");
    await executeGovernedAction(setup.request, setup.decision, setup.dependencies);
    const collision: ActionRequest = {
      ...setup.request,
      id: "request-idempotency-collision",
      intent: "Different action with a reused idempotency key",
      action: {
        ...setup.request.action,
        retryPayloadHash: "e".repeat(64),
      },
    };
    const collisionDecision = evaluateAction(
      collision,
      policy,
      setup.evidence,
      executionClock,
    );
    try {
      await executeGovernedAction(collision, collisionDecision, setup.dependencies);
      return {
        code: "unexpected_success",
        adapterCalls: setup.adapter.executeCalls,
        receipts: (await setup.receipts.list()).length,
      };
    } catch (error) {
      return {
        code:
          error instanceof Error && error.message.includes("already bound")
            ? "idempotency_conflict"
            : "unexpected_error",
        adapterCalls: setup.adapter.executeCalls,
        receipts: (await setup.receipts.list()).length,
      };
    }
  }
  if (id === "23-fail-before-effect" || id === "24-fail-after-effect") {
    const proposal = retry();
    if (proposal.request.action.type !== "retry_failed_lane") throw new Error("Expected retry action.");
    proposal.request.action = {
      ...proposal.request.action,
      simulateFailure: id === "23-fail-before-effect" ? "before_effect" : "after_effect",
    };
    const setup = await approvedSetup(proposal);
    const receipt = await executeGovernedAction(setup.request, setup.decision, setup.dependencies);
    return id === "23-fail-before-effect"
      ? { code: receipt.result, effects: receipt.effects.length }
      : { code: receipt.result, restored: (await readFile(setup.adapter.retryPath, "utf8")) === "" };
  }
  if (id === "25-verification-mismatch") {
    const setup = await approvedSetup();
    setup.dependencies.adapter.verify = async () => ({ passed: false, detail: "forced mismatch" });
    const receipt = await executeGovernedAction(
      setup.request,
      setup.decision,
      setup.dependencies,
    );
    return {
      code: receipt.result,
      restored: (await readFile(setup.adapter.retryPath, "utf8")) === "",
    };
  }
  if (id === "26-tampered-receipt") {
    const setup = await approvedSetup();
    const receipt = await executeGovernedAction(setup.request, setup.decision, setup.dependencies);
    return { code: verifyReceipt({ ...receipt, result: "failed" }).valid ? "valid" : "invalid" };
  }
  if (id === "27-approval-provider-absent") {
    const setup = await executorSetup();
    const receipt = await executeGovernedAction(setup.request, setup.decision, { ...setup.dependencies, approvals: null });
    return { code: receipt.result, effects: receipt.effects.length };
  }
  if (id === "28-mcp-approval-attempt") {
    return { code: AGENT_TOOL_NAMES.map(String).includes("approve_action") ? "capability_present" : "capability_absent" };
  }
  if (id === "29-forged-browser-decision") {
    const proposal = retry();
    const forged = { ...evaluateAction(proposal.request, policy, proposal.evidence, decisionClock), decisionDigest: "a".repeat(64) };
    const result = recomputeImportedDecision({ request: proposal.request, diagnostic, decision: forged }, policy, decisionClock);
    return { code: result.importedDecisionAccepted ? "forgery_accepted" : "forgery_rejected" };
  }
  if (id === "30-demo-drift") {
    const left = buildPublicDemo(diagnostic, policy, decisionClock);
    const right = buildPublicDemo(structuredClone(diagnostic), structuredClone(policy), decisionClock);
    return { code: JSON.stringify(left) === JSON.stringify(right) ? "in_sync" : "drift" };
  }
  if (id === "31-policy-change") {
    const setup = await approvedSetup();
    const changedPolicy = { ...policy, version: "1.0.1" };
    const receipt = await executeGovernedAction(setup.request, setup.decision, { ...setup.dependencies, policy: changedPolicy });
    return { code: receipt.result, effects: receipt.effects.length };
  }
  if (id === "32-review-ready" || id === "33-review-approval") {
    const adapter = new SyntheticAutomationAdapter(
      await mkdtemp(join(tmpdir(), "governed-review-")),
    );
    const review = await prepareActionReview(
      diagnostic,
      {
        actionType:
          id === "32-review-ready" ? "inspect_run_receipt" : "retry_failed_lane",
        laneId: "site-refresh",
      },
      policy,
      adapter,
      decisionClock,
    );
    return { code: review.status, adapterCalls: adapter.executeCalls };
  }
  if (id === "34-review-tamper") {
    const review = await prepareActionReview(
      diagnostic,
      { actionType: "retry_failed_lane", laneId: "site-refresh" },
      policy,
      new SyntheticAutomationAdapter(await mkdtemp(join(tmpdir(), "governed-review-"))),
      decisionClock,
    );
    try {
      verifyActionReview({ ...review, reviewDigest: "a".repeat(64) });
      return { code: "tamper_accepted" };
    } catch {
      return { code: "tamper_rejected" };
    }
  }
  throw new Error(`No evaluator for ${id}.`);
}

const cases = [
  ...(JSON.parse(await readFile("evals/action-cases.json", "utf8")) as EvalCase[]),
  ...(JSON.parse(await readFile("evals/execution-cases.json", "utf8")) as EvalCase[]),
];
let passed = 0;
for (const evaluation of cases) {
  const actual = await runCase(evaluation.id);
  try {
    assert.deepEqual(actual, evaluation.expected);
    passed += 1;
    process.stdout.write(`PASS ${evaluation.id}\n`);
  } catch {
    process.stderr.write(`FAIL ${evaluation.id}\nexpected ${JSON.stringify(evaluation.expected)}\nactual   ${JSON.stringify(actual)}\n`);
  }
}
process.stdout.write(`${passed}/${cases.length} evaluations passed\n`);
if (passed !== cases.length) process.exitCode = 1;
