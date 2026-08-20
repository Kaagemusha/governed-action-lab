import { digestOmitting, sha256 } from "./canonical.js";
import {
  RECEIPT_VERSION,
  executionReceiptSchema,
  type ExecutionReceipt,
  type PolicyManifest,
} from "./contracts.js";
import { proposeActionFromDiagnostic, recheckProposal } from "./context-adapter.js";
import { evaluateAction, type Clock } from "./policy.js";
import { verifyReceipt } from "./receipts.js";
export { sha256 } from "./canonical.js";

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

type PublicDemoItem = ReturnType<typeof buildPublicDemo>[number];

export function buildSyntheticBrowserReceipt(
  item: PublicDemoItem,
  kind: "read" | "retry",
): ExecutionReceipt {
  if (
    (kind === "read" &&
      (item.request.action.type !== "inspect_run_receipt" ||
        item.decision.disposition !== "allow")) ||
    (kind === "retry" &&
      (item.request.action.type !== "retry_failed_lane" ||
        item.decision.disposition !== "approval_required"))
  ) {
    throw new Error(`Synthetic ${kind} receipt does not match the governed action.`);
  }
  const beforeHash = item.request.expectedState.contentHash;
  if (!beforeHash) {
    throw new Error("Synthetic browser receipt requires an expected content hash.");
  }
  const afterHash =
    kind === "read"
      ? beforeHash
      : sha256({
          laneId: item.request.action.laneId,
          evidenceRecordId: item.request.action.recordId,
          synthetic: true,
        });
  const observedAt = item.decision.decisionAt;
  const partial = {
    schemaVersion: RECEIPT_VERSION,
    id: `browser-receipt-${sha256({
      requestId: item.request.id,
      decisionDigest: item.decision.decisionDigest,
      kind,
      afterHash,
    }).slice(0, 20)}`,
    requestId: item.request.id,
    actionDigest: item.decision.actionDigest,
    decisionDigest: item.decision.decisionDigest,
    approvalId:
      kind === "retry"
        ? `browser-synthetic-approval-${item.request.id}`
        : null,
    adapter: { id: "governed-automation", version: "browser-synthetic/1" },
    startedAt: observedAt,
    endedAt: observedAt,
    result: "succeeded",
    preconditionCheck: {
      passed: true,
      detail: "Expected content hash matched in the browser-only synthetic state.",
    },
    effects: [
      {
        kind: kind === "read" ? "read" : "create_synthetic_retry_record",
        resourceId: item.request.target.resourceId,
        beforeHash,
        afterHash,
      },
    ],
    verification: {
      passed: true,
      detail:
        kind === "read"
          ? "Synthetic read preserved the target hash; no external system was contacted."
          : "Synthetic retry record matches lane, evidence, and content hash; no external system was contacted.",
    },
    compensation: {
      supported: kind === "retry",
      authorized: kind === "retry",
      attempted: false,
      result: "not_needed",
    },
    previousReceiptId: null,
    receiptDigest: "0".repeat(64),
  } satisfies ExecutionReceipt;
  partial.receiptDigest = digestOmitting(partial, "receiptDigest");
  const receipt = executionReceiptSchema.parse(partial);
  const verified = verifyReceipt(receipt);
  if (!verified.valid) {
    throw new Error(`Synthetic browser receipt failed verification: ${verified.detail}`);
  }
  return receipt;
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
