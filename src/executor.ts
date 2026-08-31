import type { ApprovalStore } from "./approval.js";
import { validateApproval } from "./approval.js";
import type { ActionAdapter, AdapterExecution } from "./adapters/synthetic-automation.js";
import {
  actionRequestSchema,
  policyDecisionSchema,
  type ActionRequest,
  type ExecutionReceipt,
  type PolicyDecision,
  type PolicyManifest,
  type PolicyTrustBinding,
} from "./contracts.js";
import { digestOmitting } from "./canonical.js";
import { actionDigest, evaluateAction, type Clock, type EvidenceEligibility, systemClock } from "./policy.js";
import { createReceipt } from "./receipts.js";
import type { ClaimCheckpoint, ReceiptStore } from "./store.js";

export type ExecutionState = {
  evidence: EvidenceEligibility;
  currentTargetHash: string;
  diagnosticAsOf: string;
};

export type ExecutorDependencies = {
  policy: PolicyManifest;
  policyTrust?: PolicyTrustBinding;
  evidence: EvidenceEligibility;
  loadCurrentState(): Promise<ExecutionState>;
  adapter: ActionAdapter;
  approvals: ApprovalStore | null;
  receipts: ReceiptStore;
  verifiedPrincipal: ActionRequest["proposer"];
  clock?: Clock;
  actionIdFactory?: () => string;
  parentActionId?: string;
  receiptIdFactory?: () => string;
};

export class IdempotencyStateError extends Error {
  constructor(
    readonly code: "IDEMPOTENCY_CONFLICT" | "IDEMPOTENCY_IN_PROGRESS" | "IDEMPOTENCY_RECOVERY_AMBIGUOUS",
    idempotencyKey: string,
  ) {
    super(
      code === "IDEMPOTENCY_CONFLICT"
        ? `Idempotency key "${idempotencyKey}" is already bound to another action.`
        : code === "IDEMPOTENCY_IN_PROGRESS"
          ? `Idempotency key "${idempotencyKey}" is already executing.`
          : `Idempotency key "${idempotencyKey}" has an orphaned effect that cannot be reconciled safely.`,
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
  let claimId: string;
  let recoveryCheckpoint: ClaimCheckpoint | null = null;
  let recovered = false;
  if (claim.status === "orphaned") {
    const recovery = await dependencies.receipts.recoverOrphaned(
      request.idempotencyKey,
      requestActionDigest,
      claim.claimId,
    );
    if (!recovery) {
      throw new IdempotencyStateError("IDEMPOTENCY_IN_PROGRESS", request.idempotencyKey);
    }
    claimId = recovery.claimId;
    recoveryCheckpoint = recovery.checkpoint;
    recovered = true;
  } else {
    claimId = claim.claimId;
  }
  const actionId = recoveryCheckpoint?.actionId ?? (dependencies.actionIdFactory ??
    (() => `action-${globalThis.crypto.randomUUID()}`))();
  let preserveClaim = recoveryCheckpoint !== null;

  const executeClaimed = async (): Promise<ExecutionReceipt> => {
  const clock = dependencies.clock ?? systemClock;
  const startedAt = recoveryCheckpoint?.startedAt ?? clock.now().toISOString();
  const current = await dependencies.loadCurrentState();
  const currentDecision = evaluateAction(
    request,
    dependencies.policy,
    current.evidence,
    { now: () => new Date(decision.decisionAt) },
    dependencies.policyTrust,
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
    decision.policy.version !== dependencies.policy.version ||
    decision.policy.manifestDigest !== dependencies.policyTrust?.manifestDigest;
  const targetChanged = expectedHash !== undefined && expectedHash !== current.currentTargetHash;

  const finish = async (
    result: ExecutionReceipt["result"],
    detail: string,
    options: Partial<Parameters<typeof createReceipt>[0]> = {},
  ): Promise<ExecutionReceipt> => {
    const receipt = createReceipt({
      actionId,
      ...(dependencies.parentActionId === undefined
        ? {}
        : { parentActionId: dependencies.parentActionId }),
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

  let recoveredExecution: AdapterExecution | undefined;
  if (recovered && recoveryCheckpoint) {
    if (!dependencies.approvals) {
      throw new IdempotencyStateError(
        "IDEMPOTENCY_RECOVERY_AMBIGUOUS",
        request.idempotencyKey,
      );
    }
    if (dependencies.adapter.id !== request.target.adapterId) {
      throw new IdempotencyStateError(
        "IDEMPOTENCY_RECOVERY_AMBIGUOUS",
        request.idempotencyKey,
      );
    }
    const reconciliation = await dependencies.adapter.reconcile(
      request,
      recoveryCheckpoint.adapterState,
    );
    if (reconciliation.status === "ambiguous") {
      throw new IdempotencyStateError(
        "IDEMPOTENCY_RECOVERY_AMBIGUOUS",
        request.idempotencyKey,
      );
    }
    if (reconciliation.status === "applied") {
      recoveredExecution = reconciliation.execution;
      const verification = await dependencies.adapter.verify(request, recoveredExecution);
      await dependencies.approvals.consume(recoveryCheckpoint.approval);
      return finish(verification.passed ? "succeeded" : "failed", "Recovered an orphaned synthetic effect from its durable checkpoint.", {
        approvalId: recoveryCheckpoint.approval.id,
        effects: recoveredExecution.effects,
        verification,
        precondition: { passed: true, detail: "The durable checkpoint and current synthetic effect reconcile exactly." },
        compensation: {
          supported: true,
          authorized: recoveryCheckpoint.approval.failureCompensationAuthorized,
          attempted: false,
          result: "not_needed",
        },
      });
    }
  }

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
    if (recoveryCheckpoint) {
      approvalId = recoveryCheckpoint.approval.id;
      compensationAuthorized = recoveryCheckpoint.approval.failureCompensationAuthorized;
      if (!dependencies.approvals) {
        throw new IdempotencyStateError(
          "IDEMPOTENCY_RECOVERY_AMBIGUOUS",
          request.idempotencyKey,
        );
      }
      await dependencies.approvals.consume(recoveryCheckpoint.approval);
    } else {
      const approval = await validateApproval(
        dependencies.approvals,
        request,
        currentDecision,
        clock,
      );
      if (!approval.valid) {
        return finish(approval.code === "expired" ? "expired" : "refused", `Approval validation failed: ${approval.code}.`);
      }
      const adapterState = await dependencies.adapter.prepareRecovery(request);
      const checkpoint: ClaimCheckpoint = {
        actionId,
        startedAt,
        approval: approval.grant,
        adapterState,
      };
      await dependencies.receipts.checkpoint(
        request.idempotencyKey,
        requestActionDigest,
        claimId,
        checkpoint,
      );
      preserveClaim = true;
      if (!dependencies.approvals || !(await dependencies.approvals.consume(approval.grant))) {
        return finish("refused", "Approval validation failed: replayed.");
      }
      recoveryCheckpoint = checkpoint;
      approvalId = approval.grant.id;
      compensationAuthorized = approval.grant.failureCompensationAuthorized;
    }
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
    execution = recoveredExecution ?? await dependencies.adapter.execute(request);
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
    if (!preserveClaim) {
      await dependencies.receipts.release(
        request.idempotencyKey,
        requestActionDigest,
      );
    }
    throw error;
  }
}
