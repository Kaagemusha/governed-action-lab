import type { PolicyManifest } from "./contracts.js";
import { proposeActionFromDiagnostic, recheckProposal } from "./context-adapter.js";
import { evaluateAction, type Clock } from "./policy.js";

export function buildPublicDemo(diagnostic: unknown, policy: PolicyManifest, clock: Clock) {
  return [
    ["inspect_run_receipt", "site-refresh"],
    ["retry_failed_lane", "site-refresh"],
    ["delete_preserved_output", "research-watch"],
  ].map(([actionType, laneId]) => {
    const proposal = proposeActionFromDiagnostic(diagnostic, {
      actionType: actionType as "inspect_run_receipt" | "retry_failed_lane" | "delete_preserved_output",
      laneId: laneId!,
    });
    return {
      actionType,
      request: proposal.request,
      decision: evaluateAction(proposal.request, policy, proposal.evidence, clock),
    };
  });
}

export function recomputeImportedDecision(
  bundle: { request: unknown; decision?: unknown; diagnostic: unknown },
  policy: PolicyManifest,
  clock: Clock,
) {
  const adapted = recheckProposal(bundle.diagnostic, bundle.request as never);
  const decision = evaluateAction(bundle.request, policy, adapted.evidence, clock);
  const supplied = bundle.decision;
  const suppliedDigest =
    supplied && typeof supplied === "object" && "decisionDigest" in supplied
      ? String(supplied.decisionDigest)
      : null;
  return {
    request: adapted.request,
    decision,
    importedDecisionAccepted: suppliedDigest === null || suppliedDigest === decision.decisionDigest,
  };
}
