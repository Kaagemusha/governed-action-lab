import type { ActionAdapter } from "./adapters/synthetic-automation.js";
import { digestOmitting, sha256 } from "./canonical.js";
import {
  DIAGNOSTIC_V2_VERSION,
  REVIEW_VERSION,
  REVIEW_V2_VERSION,
  actionReviewSchema,
  type ActionReview,
  type CatalogAction,
  type PolicyManifest,
  type PolicyTrustBinding,
} from "./contracts.js";
import { proposeActionFromDiagnostic } from "./context-adapter.js";
import { actionDigest, evaluateAction, type Clock } from "./policy.js";

export async function prepareActionReview(
  diagnosticInput: unknown,
  input: { actionType: CatalogAction["type"]; laneId: string; proposerId?: string },
  policy: PolicyManifest,
  adapter: ActionAdapter,
  clock?: Clock,
  policyTrust?: PolicyTrustBinding,
): Promise<ActionReview> {
  const proposal = proposeActionFromDiagnostic(diagnosticInput, {
    actionType: input.actionType,
    laneId: input.laneId,
    proposerId: input.proposerId ?? "operator-review",
    ...(clock ? { proposedAt: clock.now().toISOString() } : {}),
  });
  const decision = evaluateAction(
    proposal.request,
    policy,
    proposal.evidence,
    clock ?? { now: () => new Date(proposal.request.proposedAt) },
    policyTrust,
  );
  const plan = await adapter.plan(proposal.request);
  const status = {
    allow: "READY",
    approval_required: "APPROVAL_REQUIRED",
    refuse: "REFUSED",
  }[decision.disposition] as ActionReview["status"];
  const versioned =
    proposal.diagnostic.format === DIAGNOSTIC_V2_VERSION
      ? {
          schemaVersion: REVIEW_V2_VERSION,
          diagnostic: {
            format: DIAGNOSTIC_V2_VERSION,
            digest: proposal.request.evidence.diagnosticHash,
            asOf: proposal.diagnostic.scenario.asOf,
          },
        } as const
      : {
          schemaVersion: REVIEW_VERSION,
          diagnostic: {
            format: proposal.diagnostic.format,
            digest: proposal.request.evidence.diagnosticHash,
            asOf: proposal.diagnostic.scenario.asOf,
          },
        } as const;
  const partial = {
    ...versioned,
    id: `review-${sha256({ request: proposal.request, decision }).slice(0, 16)}`,
    request: proposal.request,
    decision,
    plan,
    status,
    reviewDigest: "0".repeat(64),
  } satisfies ActionReview;
  partial.reviewDigest = digestOmitting(partial, "reviewDigest");
  return actionReviewSchema.parse(partial);
}

export function verifyActionReview(input: unknown): ActionReview {
  const review = actionReviewSchema.parse(input);
  const expectedStatus = {
    allow: "READY",
    approval_required: "APPROVAL_REQUIRED",
    refuse: "REFUSED",
  }[review.decision.disposition];
  if (review.request.id !== review.decision.requestId) {
    throw new Error("Review decision does not reference its request.");
  }
  if (review.decision.actionDigest !== actionDigest(review.request)) {
    throw new Error("Review decision is not bound to its request.");
  }
  if (
    review.decision.decisionDigest !==
    digestOmitting(review.decision, "decisionDigest")
  ) {
    throw new Error("Review decision digest verification failed.");
  }
  if (review.diagnostic.digest !== review.request.evidence.diagnosticHash) {
    throw new Error("Review diagnostic digest does not match the request evidence.");
  }
  if (review.diagnostic.format !== review.request.evidence.diagnosticFormat) {
    throw new Error("Review diagnostic format does not match the request evidence.");
  }
  if (review.diagnostic.asOf !== review.request.evidence.asOf) {
    throw new Error("Review diagnostic time does not match the request evidence.");
  }
  if (review.status !== expectedStatus) {
    throw new Error("Review status does not match the policy disposition.");
  }
  const expectedId = `review-${sha256({
    request: review.request,
    decision: review.decision,
  }).slice(0, 16)}`;
  if (review.id !== expectedId) {
    throw new Error("Review identity does not match its request and decision.");
  }
  if (review.reviewDigest !== digestOmitting(review, "reviewDigest")) {
    throw new Error("Review digest verification failed.");
  }
  return review;
}

export function renderActionReviewBrief(input: unknown): string {
  const review = verifyActionReview(input);
  const authority = {
    READY: "Read-only policy allows execution without human approval.",
    APPROVAL_REQUIRED: "Exact, expiring human approval is required; the agent cannot approve.",
    REFUSED: "Policy refuses execution; approval cannot override the refusal.",
  }[review.status];
  const next = {
    READY: "The bounded read may execute after current-state recheck.",
    APPROVAL_REQUIRED: "Review the exact target, effect, evidence, expiry, and rollback contract.",
    REFUSED: "Use the stated safer alternative or revise the proposal outside this action.",
  }[review.status];
  return [
    "# Governed Action Review",
    `- Status: ${review.status}`,
    `- Action: ${review.request.action.type} on ${review.request.target.resourceId}.`,
    `- Evidence: ${review.request.evidence.recordIds.length} record(s) at ${review.diagnostic.asOf}; digest ${review.diagnostic.digest.slice(0, 12)}.`,
    `- Authority: ${authority}`,
    `- Next: ${next}`,
    "",
  ].join("\n");
}
