import { SyntheticAutomationAdapter } from "./adapters/synthetic-automation.js";
import { digestOmitting, sha256 } from "./canonical.js";
import {
  DIAGNOSTIC_V2_VERSION,
  PROOF_VERSION,
  type DiagnosticSnapshotV2,
  type PolicyManifest,
  type ProofPacket,
  diagnosticSnapshotSchema,
  proofPacketSchema,
} from "./contracts.js";
import { proposeActionFromDiagnostic } from "./context-adapter.js";
import { executeGovernedAction } from "./executor.js";
import { prepareActionReview, verifyActionReview } from "./operator-review.js";
import { actionDigest } from "./policy.js";
import { verifyReceipt } from "./receipts.js";
import { MemoryReceiptStore } from "./store.js";

export const PORTABLE_PROOF_SOURCE = {
  producer: "Kaagemusha/context-layer-lab",
  producerCommit: "5d74a5c5a0d1269a916612bcc69db60003ea69b8",
  producerArtifact: "docs/operational-health.json",
  format: DIAGNOSTIC_V2_VERSION,
  fixtureSha256: "2398c03fe8d80c941dc66827be0a4a7015f799d63cda06dbdc84778934273064",
  diagnosticCanonicalSha256: "3856460b1b54ff9dcfe7b86e442dac7ca1dc021c9d835f486f609950efab69c5",
} as const;

export const PORTABLE_PROOF_POLICY_SHA256 =
  "8c50cd5756e5da687404fc295bf1e17738c81d86ff6b430fda798fb99cca6e7c";
export const PORTABLE_PROOF_LANE = "site-refresh";
export const PORTABLE_PROOF_RECEIPT_ID = "receipt-portable-green-v2";

type FixtureMetadata = Omit<typeof PORTABLE_PROOF_SOURCE, "diagnosticCanonicalSha256"> & {
  fixture: string;
};

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Portable proof verification failed: ${message}`);
}

function equalCanonical(left: unknown, right: unknown): boolean {
  return sha256(left) === sha256(right);
}

function assertFrozenSource(source: ProofPacket["diagnosticSource"]): void {
  invariant(equalCanonical(source, PORTABLE_PROOF_SOURCE), "diagnostic provenance is not the frozen v2 source");
}

function assertTrustedPolicy(policy: PolicyManifest): void {
  invariant(policy.schemaVersion === "governed-action-policy/v1", "policy schema is not v1");
  invariant(policy.id === "governed-action-lab-public-policy", "policy identity is not public");
  invariant(policy.version === "1.3.0", "policy version is not 1.3.0");
  invariant(sha256(policy) === PORTABLE_PROOF_POLICY_SHA256, "policy differs from the trusted public policy");
}

export async function buildPortableGreenProof(input: {
  diagnostic: DiagnosticSnapshotV2;
  metadata: FixtureMetadata;
  policy: PolicyManifest;
}): Promise<ProofPacket> {
  invariant(input.metadata.fixture === "context-layer-diagnostic-v2.json", "metadata names an unexpected fixture");
  invariant(
    equalCanonical(input.metadata, {
      producer: PORTABLE_PROOF_SOURCE.producer,
      producerCommit: PORTABLE_PROOF_SOURCE.producerCommit,
      producerArtifact: PORTABLE_PROOF_SOURCE.producerArtifact,
      format: PORTABLE_PROOF_SOURCE.format,
      fixture: "context-layer-diagnostic-v2.json",
      fixtureSha256: PORTABLE_PROOF_SOURCE.fixtureSha256,
    }),
    "fixture metadata is not the frozen v2 source",
  );
  invariant(sha256(input.diagnostic) === PORTABLE_PROOF_SOURCE.diagnosticCanonicalSha256, "diagnostic differs from the frozen fixture");
  assertTrustedPolicy(input.policy);

  const frozenAt = input.diagnostic.scenario.asOf;
  const clock = { now: () => new Date(frozenAt) };
  const adapter = new SyntheticAutomationAdapter(".");
  const review = await prepareActionReview(
    input.diagnostic,
    { actionType: "inspect_run_receipt", laneId: PORTABLE_PROOF_LANE, proposerId: "portable-proof-generator" },
    input.policy,
    adapter,
    clock,
  );
  invariant(review.schemaVersion === "governed-action-review/v2", "generated review is not v2");
  const proposal = proposeActionFromDiagnostic(input.diagnostic, {
    actionType: "inspect_run_receipt",
    laneId: PORTABLE_PROOF_LANE,
    proposerId: "portable-proof-generator",
    proposedAt: frozenAt,
  });
  const receipt = await executeGovernedAction(review.request, review.decision, {
    policy: input.policy,
    evidence: proposal.evidence,
    loadCurrentState: async () => ({
      evidence: proposal.evidence,
      currentTargetHash: proposal.targetHash,
      diagnosticAsOf: frozenAt,
    }),
    adapter,
    approvals: null,
    receipts: new MemoryReceiptStore(),
    clock,
    receiptIdFactory: () => PORTABLE_PROOF_RECEIPT_ID,
  });
  const partial = {
    schemaVersion: PROOF_VERSION,
    mode: "synthetic_green_inspection",
    synthetic: true,
    diagnosticSource: PORTABLE_PROOF_SOURCE,
    diagnostic: input.diagnostic,
    policy: input.policy,
    review,
    approvalBoundary: { required: false, grant: null },
    receipt,
    packetDigest: "0".repeat(64),
  } satisfies ProofPacket;
  partial.packetDigest = digestOmitting(partial, "packetDigest");
  return verifyPortableProof(partial);
}

export async function verifyPortableProof(input: unknown): Promise<ProofPacket> {
  const packet = proofPacketSchema.parse(input);
  diagnosticSnapshotSchema.parse(packet.diagnostic);
  assertFrozenSource(packet.diagnosticSource);
  invariant(sha256(packet.diagnostic) === packet.diagnosticSource.diagnosticCanonicalSha256, "diagnostic canonical digest does not match provenance");
  assertTrustedPolicy(packet.policy);
  invariant(packet.diagnostic.format === DIAGNOSTIC_V2_VERSION, "diagnostic is not v2");

  const frozenAt = packet.diagnostic.scenario.asOf;
  const frozenExecutionAt = new Date(frozenAt).toISOString();
  invariant(packet.review.schemaVersion === "governed-action-review/v2", "review is not v2");
  invariant(packet.review.status === "READY", "review is not READY");
  invariant(packet.review.request.action.type === "inspect_run_receipt", "action is not a green inspection");
  invariant(packet.review.request.action.laneId === PORTABLE_PROOF_LANE, "action targets the wrong lane");
  invariant(packet.review.request.target.environment === "read_only", "action target is not read-only");
  invariant(packet.review.request.proposedAt === frozenExecutionAt, "request time is not frozen to the diagnostic");
  invariant(packet.review.decision.decisionAt === frozenExecutionAt, "decision time is not frozen to the diagnostic");
  invariant(packet.review.diagnostic.digest === sha256(packet.diagnostic), "review diagnostic digest is incorrect");
  invariant(packet.review.request.evidence.diagnosticHash === sha256(packet.diagnostic), "request diagnostic digest is incorrect");
  invariant(packet.review.request.evidence.diagnosticFormat === DIAGNOSTIC_V2_VERSION, "request evidence is not v2");
  invariant(packet.review.request.evidence.asOf === frozenAt, "request evidence time is not frozen");
  verifyActionReview(packet.review);

  const expectedReview = await prepareActionReview(
    packet.diagnostic,
    { actionType: "inspect_run_receipt", laneId: PORTABLE_PROOF_LANE, proposerId: "portable-proof-generator" },
    packet.policy,
    new SyntheticAutomationAdapter("."),
    { now: () => new Date(frozenAt) },
  );
  invariant(equalCanonical(packet.review, expectedReview), "review does not match deterministic policy evaluation and plan");
  invariant(packet.approvalBoundary.required === false && packet.approvalBoundary.grant === null, "green proof cannot carry approval authority");

  const receipt = packet.receipt;
  invariant(verifyReceipt(receipt).valid, "receipt schema or digest is invalid");
  invariant(receipt.id === PORTABLE_PROOF_RECEIPT_ID, "receipt identity is not deterministic");
  invariant(receipt.requestId === packet.review.request.id, "receipt is not bound to the request");
  invariant(receipt.actionDigest === actionDigest(packet.review.request), "receipt action digest is incorrect");
  invariant(receipt.decisionDigest === packet.review.decision.decisionDigest, "receipt is not bound to the decision");
  invariant(receipt.approvalId === null, "green receipt must not carry an approval");
  invariant(receipt.adapter.id === "governed-automation" && receipt.adapter.version === "1.0.0", "receipt adapter is not the actual synthetic executor");
  invariant(receipt.result === "succeeded", "green inspection did not succeed");
  invariant(receipt.preconditionCheck.passed, "receipt precondition did not pass");
  invariant(receipt.verification.passed, "receipt verification did not pass");
  invariant(receipt.startedAt === frozenExecutionAt && receipt.endedAt === frozenExecutionAt, "receipt times are not coherent and frozen");
  invariant(new Date(receipt.startedAt).getTime() <= new Date(receipt.endedAt).getTime(), "receipt ends before it starts");
  invariant(receipt.previousReceiptId === null, "portable proof must be a first receipt");
  invariant(receipt.effects.length === 1, "green inspection must have exactly one effect record");
  const effect = receipt.effects[0]!;
  invariant(effect.kind === "read", "green inspection effect is not read-only");
  invariant(effect.resourceId === packet.review.request.target.resourceId, "receipt effect targets the wrong resource");
  invariant(effect.beforeHash === packet.review.request.expectedState.contentHash, "receipt does not bind the expected content hash");
  invariant(effect.afterHash === effect.beforeHash, "read-only receipt records a state change");
  invariant(!receipt.compensation.supported && !receipt.compensation.authorized && !receipt.compensation.attempted && receipt.compensation.result === "not_needed", "green inspection has an invalid compensation boundary");
  invariant(packet.packetDigest === digestOmitting(packet, "packetDigest"), "outer packet digest does not match");
  return packet;
}
