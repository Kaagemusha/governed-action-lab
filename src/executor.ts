import type { ApprovalStore } from "./approval.js";
import { validateAndConsumeApproval } from "./approval.js";
import type { ActionAdapter, AdapterExecution } from "./adapters/synthetic-automation.js";
import {
  actionRequestSchema,
  policyDecisionSchema,
  type ActionRequest,
  type ExecutionReceipt,
  type PolicyDecision,
  type PolicyManifest,
} from "./contracts.js";
import { digestOmitting } from "./canonical.js";
import { actionDigest, evaluateAction, type Clock, type EvidenceEligibility, systemClock } from "./policy.js";
import { createReceipt } from "./receipts.js";
import type { ReceiptStore } from "./store.js";

export type ExecutionState = {
  evidence: EvidenceEligibility;
  currentTargetHash: string;
  diagnosticAsOf: string;
};

export type ExecutorDependencies = {
  policy: PolicyManifest;
  evidence: EvidenceEligibility;
  loadCurrentState(): Promise<ExecutionState>;
  adapter: ActionAdapter;
  approvals: ApprovalStore | null;
  receipts: ReceiptStore;
  verifiedPrincipal: ActionRequest["proposer"];
  clock?: Clock;
  receiptIdFactory?: () => string;
};

export class IdempotencyStateError extends Error {
  constructor(
    readonly code: "IDEMPOTENCY_CONFLICT" | "IDEMPOTENCY_IN_PROGRESS",
    idempotencyKey: string,
  ) {
    super(
      code === "IDEMPOTENCY_CONFLICT"
        ? `Idempotency key "${idempotencyKey}" is already bound to another action.`
        : `Idempotency key "${idempotencyKey}" is already executing.`,
    );
    this.name = "IdempotencyStateError";
  }
}

export class PrincipalMismatchError extends Error {
  readonly code = "PRINCIPAL_MISMATCH";

  constructor() {
    super("Verified principal does not match the action proposer.");
    this.name = "PrincipalMismatchError";
  }
}

export async function executeGovernedAction(
  requestInput: unknown,
  decisionInput: unknown,
  dependencies: ExecutorDependencies,
): Promise<ExecutionReceipt> {
  const request = actionRequestSchema.parse(requestInput);
  const decision = policyDecisionSchema.parse(decisionInput);
  if (
    dependencies.verifiedPrincipal.kind !== request.proposer.kind ||
    dependencies.verifiedPrincipal.id !== request.proposer.id
  ) {
    throw new PrincipalMismatchError();
  }
  const requestActionDigest = actionDigest(request);
  const claim = await dependencies.receipts.claim(
    request.idempotencyKey,
    requestActionDigest,
  );
  if (claim.status === "replay") return claim.receipt;
  if (claim.status === "conflict") {
    throw new IdempotencyStateError("IDEMPOTENCY_CONFLICT", request.idempotencyKey);
  }
  if (claim.status === "in_progress") {
    throw new IdempotencyStateError("IDEMPOTENCY_IN_PROGRESS", request.idempotencyKey);
  }

  const executeClaimed = async (): Promise<ExecutionReceipt> => {
  const clock = dependencies.clock ?? systemClock;
  const startedAt = clock.now().toISOString();
  const current = await dependencies.loadCurrentState();
  const currentDecision = evaluateAction(
    request,
    dependencies.policy,
    current.evidence,
    { now: () => new Date(decision.decisionAt) },
  );
  const expectedHash = request.expectedState.contentHash;
  const evidenceAge =
    clock.now().getTime() - new Date(current.diagnosticAsOf).getTime();
  const staleEvidence = evidenceAge > dependencies.policy.maxEvidenceAgeSeconds * 1000;
  const decisionChanged =
    digestOmitting(decision, "decisionDigest") !== decision.decisionDigest ||
    decision.actionDigest !== requestActionDigest ||
    decision.decisionDigest !== currentDecision.decisionDigest ||
    decision.policy.id !== dependencies.policy.id ||
    decision.policy.version !== dependencies.policy.version;
  const targetChanged = expectedHash !== undefined && expectedHash !== current.currentTargetHash;

  const finish = async (
    result: ExecutionReceipt["result"],
    detail: string,
    options: Partial<Parameters<typeof createReceipt>[0]> = {},
  ): Promise<ExecutionReceipt> => {
    const receipt = createReceipt({
      request,
      decision,
      approvalId: null,
      adapter: dependencies.adapter,
      startedAt,
      endedAt: clock.now().toISOString(),
      result,
      precondition: { passed: result === "succeeded", detail },
      ...options,
    }, dependencies.receiptIdFactory);
    await dependencies.receipts.append(receipt, request.idempotencyKey);
    return receipt;
  };

  if (currentDecision.disposition === "refuse") {
    return finish("refused", "Policy refused the action before adapter execution.");
  }
  if (dependencies.adapter.id !== request.target.adapterId) {
    return finish("refused", "Runtime adapter identity does not match the authorized target.");
  }
  if (decisionChanged) return finish("stale", "Policy or decision changed; a new decision is required.");
  if (staleEvidence) return finish("stale", "Evidence expired before execution.");
  if (targetChanged) return finish("stale", "Target state changed before execution.");

  let approvalId: string | null = null;
  let compensationAuthorized = false;
  if (currentDecision.classification === "yellow") {
    const approval = await validateAndConsumeApproval(
      dependencies.approvals,
      request,
      currentDecision,
      clock,
    );
    if (!approval.valid) {
      return finish(approval.code === "expired" ? "expired" : "refused", `Approval validation failed: ${approval.code}.`);
    }
    approvalId = approval.grant.id;
    compensationAuthorized = approval.grant.failureCompensationAuthorized;
  }

  if (currentDecision.classification === "green") {
    const execution = await dependencies.adapter.inspect(request);
    const verification = await dependencies.adapter.verify(request, execution);
    return finish(verification.passed ? "succeeded" : "failed", "Read-only preconditions passed.", {
      approvalId,
      effects: execution.effects,
      verification,
      precondition: { passed: true, detail: "Read-only request and evidence remain current." },
    });
  }

  let execution: AdapterExecution | undefined;
  try {
    execution = await dependencies.adapter.execute(request);
    const verification = await dependencies.adapter.verify(request, execution);
    if (!verification.passed && compensationAuthorized) {
      try {
        const compensation = await dependencies.adapter.compensate(request, execution);
        return finish(compensation.passed ? "compensated" : "failed", "Verification failed after the effect.", {
          approvalId,
          effects: execution.effects,
          verification,
          precondition: { passed: true, detail: "Evidence, policy, approval, and target state rechecked." },
          compensation: {
            supported: true,
            authorized: true,
            attempted: true,
            result: compensation.passed ? "succeeded" : "failed",
          },
        });
      } catch (error) {
        return finish("failed", "Verification and compensation failed after the effect.", {
          approvalId,
          effects: execution.effects,
          verification,
          precondition: { passed: true, detail: "Evidence, policy, approval, and target state rechecked." },
          compensation: {
            supported: true,
            authorized: true,
            attempted: true,
            result: "failed",
          },
        });
      }
    }
    return finish(verification.passed ? "succeeded" : "failed", "Mutation preconditions passed.", {
      approvalId,
      effects: execution.effects,
      verification,
      precondition: { passed: true, detail: "Evidence, policy, approval, and target state rechecked." },
      compensation: {
        supported: true,
        authorized: compensationAuthorized,
        attempted: false,
        result: "not_needed",
      },
    });
  } catch (error) {
    execution = (error as Error & { execution?: AdapterExecution }).execution;
    if (execution && compensationAuthorized) {
      const compensation = await dependencies.adapter.compensate(request, execution);
      return finish(compensation.passed ? "compensated" : "failed", "Execution failed after a partial effect.", {
        approvalId,
        effects: execution.effects,
        precondition: { passed: true, detail: "Preconditions passed before adapter failure." },
        verification: { passed: false, detail: error instanceof Error ? error.message : "Adapter failed." },
        compensation: {
          supported: true,
          authorized: true,
          attempted: true,
          result: compensation.passed ? "succeeded" : "failed",
        },
      });
    }
    return finish("failed", error instanceof Error ? error.message : "Adapter failed.", {
      approvalId,
      precondition: { passed: true, detail: "Preconditions passed before adapter failure." },
      compensation: {
        supported: true,
        authorized: compensationAuthorized,
        attempted: false,
        result: execution ? "not_authorized" : "not_needed",
      },
    });
  }
  };

  try {
    return await executeClaimed();
  } catch (error) {
    await dependencies.receipts.release(
      request.idempotencyKey,
      requestActionDigest,
    );
    throw error;
  }
}
