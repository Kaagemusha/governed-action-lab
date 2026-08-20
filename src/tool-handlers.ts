import type { ApprovalStore } from "./approval.js";
import type { ActionAdapter } from "./adapters/synthetic-automation.js";
import { actionRequestSchema, policyDecisionSchema, type ActionRequest, type ExecutionReceipt, type PolicyDecision, type PolicyManifest } from "./contracts.js";
import { recheckProposal } from "./context-adapter.js";
import { executeGovernedAction, IdempotencyConflictError } from "./executor.js";
import { evaluateAction, type Clock } from "./policy.js";
import { verifyReceipt } from "./receipts.js";
import type { ReceiptStore } from "./store.js";

export const AGENT_TOOL_NAMES = [
  "evaluate_action",
  "explain_action_decision",
  "simulate_action",
  "execute_approved_action",
  "verify_action_receipt",
] as const;

export type RegisteredAction = {
  request: ActionRequest;
  decision: PolicyDecision;
  diagnostic: unknown;
};

export type ToolDependencies = {
  policy: PolicyManifest;
  adapter: ActionAdapter;
  approvals: ApprovalStore | null;
  receipts: ReceiptStore;
  registry: Map<string, RegisteredAction>;
  clock: Clock;
};

export function handleEvaluateAction(
  dependencies: ToolDependencies,
  input: { request: unknown; diagnostic: unknown },
): { ok: true; result: PolicyDecision } {
  const request = actionRequestSchema.parse(input.request);
  const adapted = recheckProposal(input.diagnostic, request);
  const decision = evaluateAction(request, dependencies.policy, adapted.evidence, dependencies.clock);
  dependencies.registry.set(request.id, { request, decision, diagnostic: input.diagnostic });
  return { ok: true, result: decision };
}

export function handleExplainDecision(
  input: { decision: unknown },
): { ok: true; result: Pick<PolicyDecision, "classification" | "disposition" | "reasons" | "requirements"> } {
  const decision = policyDecisionSchema.parse(input.decision);
  return {
    ok: true,
    result: {
      classification: decision.classification,
      disposition: decision.disposition,
      reasons: decision.reasons,
      requirements: decision.requirements,
    },
  };
}

export async function handleSimulateAction(
  dependencies: ToolDependencies,
  input: { request: unknown },
): Promise<{ ok: true; result: Awaited<ReturnType<ActionAdapter["plan"]>> }> {
  return { ok: true, result: await dependencies.adapter.plan(actionRequestSchema.parse(input.request)) };
}

export async function handleExecuteApprovedAction(
  dependencies: ToolDependencies,
  input: { actionId: string },
): Promise<{ ok: boolean; result: ExecutionReceipt | { code: string; message: string } }> {
  const registered = dependencies.registry.get(input.actionId);
  if (!registered) {
    return { ok: false, result: { code: "ACTION_NOT_REGISTERED", message: "Evaluate this action before requesting execution." } };
  }
  const adapted = recheckProposal(registered.diagnostic, registered.request);
  let receipt: ExecutionReceipt;
  try {
    receipt = await executeGovernedAction(registered.request, registered.decision, {
      policy: dependencies.policy,
      evidence: adapted.evidence,
      loadCurrentState: async () => ({
        evidence: adapted.evidence,
        currentTargetHash: adapted.targetHash,
        diagnosticAsOf: adapted.diagnostic.scenario.asOf,
      }),
      adapter: dependencies.adapter,
      approvals: dependencies.approvals,
      receipts: dependencies.receipts,
      clock: dependencies.clock,
    });
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return { ok: false, result: { code: error.code, message: error.message } };
    }
    throw error;
  }
  return { ok: receipt.result === "succeeded" || receipt.result === "compensated", result: receipt };
}

export function handleVerifyReceipt(input: { receipt: unknown }) {
  const result = verifyReceipt(input.receipt);
  return { ok: result.valid, result };
}
