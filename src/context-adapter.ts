import { sha256 } from "./canonical.js";
import {
  REQUEST_VERSION,
  actionRequestSchema,
  catalogActionTypeSchema,
  diagnosticSnapshotSchema,
  type ActionRequest,
  type CatalogAction,
  type DiagnosticSnapshot,
} from "./contracts.js";
import type { EvidenceEligibility } from "./policy.js";

export type ProposalInput = {
  actionType: CatalogAction["type"];
  laneId: string;
  adapterId?: string;
  environment?: string;
  proposerId?: string;
  proposedAt?: string;
  idempotencyKey?: string;
  simulateFailure?: "none" | "before_effect" | "after_effect";
};

export type AdaptedProposal = {
  diagnostic: DiagnosticSnapshot;
  request: ActionRequest;
  evidence: EvidenceEligibility;
  targetHash: string;
};

function parseDiagnostic(input: unknown): DiagnosticSnapshot {
  const parsed = diagnosticSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.map(String).join(".") || "root";
    throw new Error(`Diagnostic is invalid at ${path}: ${issue?.message ?? "unknown error"}`);
  }
  return parsed.data;
}

function narrowLaneInvariant(snapshot: DiagnosticSnapshot, laneId: string) {
  const lane = snapshot.scenario.lanes.find((candidate) => candidate.id === laneId);
  if (!lane) throw new Error(`Lane "${laneId}" is absent from the diagnostic.`);
  const asOf = new Date(snapshot.scenario.asOf).getTime();
  if (new Date(lane.dueAt).getTime() > asOf) {
    throw new Error(`Lane "${laneId}" is not yet due.`);
  }
  const receipts = snapshot.scenario.receipts
    .filter(
      (receipt) =>
        receipt.laneId === laneId &&
        new Date(receipt.observedAt).getTime() <= asOf,
    )
    .sort(
      (left, right) =>
        new Date(right.observedAt).getTime() - new Date(left.observedAt).getTime(),
    );
  const latest = receipts[0];
  if (!latest) throw new Error(`Lane "${laneId}" has no eligible receipt.`);
  if (new Date(latest.observedAt).getTime() < new Date(lane.dueAt).getTime()) {
    throw new Error(`Lane "${laneId}" has no receipt from its current due window.`);
  }
  const assessment = snapshot.assessment.laneAssessments.find((candidate) => candidate.id === laneId);
  if (
    !assessment ||
    assessment.evidenceRecordId !== latest.recordId ||
    assessment.outcome !== latest.outcome ||
    (latest.outcome === "success" ? assessment.state !== "healthy" : assessment.state !== "attention")
  ) {
    throw new Error(`Lane "${laneId}" assessment contradicts its latest raw receipt.`);
  }
  const record = snapshot.records.find((candidate) => candidate.id === latest.recordId);
  if (!record) throw new Error(`Evidence record "${latest.recordId}" is absent.`);
  const quality = snapshot.assessment.evidenceQuality[latest.recordId];
  if (!quality || quality.state !== "valid") {
    throw new Error(`Evidence record "${latest.recordId}" is not valid.`);
  }
  if (new Date(record.validUntil).getTime() < new Date(snapshot.scenario.asOf).getTime()) {
    throw new Error(`Evidence record "${latest.recordId}" is stale.`);
  }
  return { lane, latest, assessment, record, quality };
}

export function proposeActionFromDiagnostic(
  diagnosticInput: unknown,
  input: ProposalInput,
): AdaptedProposal {
  const actionType = catalogActionTypeSchema.parse(input.actionType);
  const diagnostic = parseDiagnostic(diagnosticInput);
  const selected = narrowLaneInvariant(diagnostic, input.laneId);
  if (actionType === "retry_failed_lane" && selected.latest.outcome !== "failed") {
    throw new Error("Retry requires the latest eligible raw receipt to be failed.");
  }
  if (
    actionType === "delete_preserved_output" &&
    selected.latest.outcome !== "preserved_local"
  ) {
    throw new Error("Preserved-output deletion requires a preserved_local receipt.");
  }
  const targetHash = sha256(selected.latest);
  const diagnosticHash = sha256(diagnostic);
  const proposedAt = input.proposedAt ?? diagnostic.scenario.asOf;
  const action: CatalogAction =
    actionType === "retry_failed_lane"
      ? {
          type: "retry_failed_lane",
          laneId: input.laneId,
          recordId: selected.latest.recordId,
          retryPayloadHash: sha256({
            laneId: input.laneId,
            evidenceRecordId: selected.latest.recordId,
          }),
          simulateFailure: input.simulateFailure ?? "none",
        }
      : actionType === "delete_preserved_output"
        ? {
            type: "delete_preserved_output",
            laneId: input.laneId,
            recordId: selected.latest.recordId,
          }
        : {
            type: "inspect_run_receipt",
            laneId: input.laneId,
            recordId: selected.latest.recordId,
          };
  const actionKey = sha256({ diagnosticHash, action }).slice(0, 16);
  const request: ActionRequest = {
    schemaVersion: REQUEST_VERSION,
    id: `request-${actionKey}`,
    idempotencyKey: input.idempotencyKey ?? `action-${actionKey}`,
    proposedAt,
    proposer: { kind: "agent", id: input.proposerId ?? "public-demo-agent" },
    intent:
      actionType === "inspect_run_receipt"
        ? "Inspect the latest run receipt."
        : actionType === "retry_failed_lane"
          ? "Retry the failed lane through the selected bounded adapter."
          : "Delete the preserved local output.",
    action,
    target: {
      adapterId: input.adapterId ?? "governed-automation",
      resourceId: input.laneId,
      environment:
        input.environment ??
        (actionType === "inspect_run_receipt" ? "read_only" : "synthetic_sandbox"),
    },
    evidence: {
      diagnosticFormat: diagnostic.format,
      diagnosticHash,
      recordIds: [selected.latest.recordId],
      asOf: diagnostic.scenario.asOf,
    },
    expectedState: { contentHash: targetHash },
  };
  const parsedRequest = actionRequestSchema.parse(request);
  return {
    diagnostic,
    request: parsedRequest,
    targetHash,
    evidence: {
      presentRecordIds: diagnostic.records.map((record) => record.id),
      qualityByRecordId: Object.fromEntries(
        Object.entries(diagnostic.assessment.evidenceQuality).map(([id, value]) => [id, value.state]),
      ),
      outcome: selected.latest.outcome,
      assessmentMatchesRawEvidence: true,
    },
  };
}

export function recheckProposal(
  diagnosticInput: unknown,
  requestInput: ActionRequest,
): AdaptedProposal {
  const request = actionRequestSchema.parse(requestInput);
  const adapted = proposeActionFromDiagnostic(diagnosticInput, {
    actionType: request.action.type,
    laneId: request.action.laneId,
    adapterId: request.target.adapterId,
    environment: request.target.environment,
    proposerId: request.proposer.id,
    proposedAt: request.proposedAt,
    idempotencyKey: request.idempotencyKey,
    ...(request.action.type === "retry_failed_lane"
      ? { simulateFailure: request.action.simulateFailure }
      : {}),
  });
  const boundRequest = {
    action: request.action,
    evidence: request.evidence,
    expectedState: request.expectedState,
  };
  const expectedRequest = {
    action: adapted.request.action,
    evidence: adapted.request.evidence,
    expectedState: adapted.request.expectedState,
  };
  if (sha256(boundRequest) !== sha256(expectedRequest)) {
    throw new Error(
      "Action request no longer matches the selected diagnostic evidence.",
    );
  }
  return adapted;
}
