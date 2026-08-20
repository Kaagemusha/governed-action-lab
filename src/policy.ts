import { digestOmitting, sha256 } from "./canonical.js";
import {
  DECISION_VERSION,
  actionRequestSchema,
  policyDecisionSchema,
  policyManifestSchema,
  type ActionRequest,
  type PolicyDecision,
  type PolicyManifest,
} from "./contracts.js";
import { ACTION_CATALOG } from "./catalog.js";

export type Clock = { now(): Date };
export const systemClock: Clock = { now: () => new Date() };

export type EvidenceEligibility = {
  presentRecordIds: string[];
  qualityByRecordId: Record<string, "valid" | "degraded" | "invalid">;
  outcome: "success" | "failed" | "preserved_local" | null;
  assessmentMatchesRawEvidence: boolean;
};

type Reason = PolicyDecision["reasons"][number];

const messages: Record<string, string> = {
  ACTION_ALLOWED: "The catalog action is read-only and may execute automatically.",
  APPROVAL_REQUIRED: "This bounded reversible mutation requires exact human approval.",
  RED_ACTION_REFUSED: "Destructive or preserved-output deletion actions are not executable.",
  UNKNOWN_POLICY: "The policy identity or version is not supported.",
  UNSUPPORTED_DIAGNOSTIC: "The diagnostic format is not supported.",
  ADAPTER_MISMATCH: "The requested adapter is not allowlisted for this action.",
  ENVIRONMENT_MISMATCH: "The requested environment is not allowed for this action.",
  TARGET_MISMATCH: "The target does not match the typed action lane.",
  EVIDENCE_MISSING: "One or more required evidence records are absent.",
  EVIDENCE_INVALID: "Required evidence is invalid or degraded.",
  EVIDENCE_OUTCOME_MISMATCH: "The raw evidence outcome does not satisfy this action rule.",
  ASSESSMENT_MISMATCH: "The selected lane assessment contradicts its raw receipt evidence.",
  GREEN_MUTATION_MISMATCH: "A green action cannot target a mutating environment.",
  CATALOG_REFUSAL: "The closed action catalog marks this action as structurally unexecutable.",
};

function reason(
  code: keyof typeof messages,
  ruleId: string,
  evidenceRecordIds: string[],
): Reason {
  return { code, message: messages[code]!, evidenceRecordIds, policyRuleId: ruleId };
}

export function actionDigest(request: ActionRequest): string {
  return sha256(request);
}

export function evaluateAction(
  input: unknown,
  manifestInput: unknown,
  evidence: EvidenceEligibility,
  clock: Clock = systemClock,
): PolicyDecision {
  const request = actionRequestSchema.parse(input);
  const manifest = policyManifestSchema.parse(manifestInput);
  const rule = manifest.rules.find((candidate) => candidate.actionType === request.action.type);
  if (!rule) throw new Error(`No policy rule exists for ${request.action.type}.`);

  const reasons: Reason[] = [];
  const evidenceIds = request.evidence.recordIds;
  const publicPolicy =
    manifest.id === "governed-action-lab-public-policy" &&
    ["1.1.0", "1.2.0"].includes(manifest.version);

  if (!publicPolicy) reasons.push(reason("UNKNOWN_POLICY", rule.id, []));
  const acceptedDiagnosticFormats =
    manifest.version === "1.1.0"
      ? [manifest.diagnosticFormat]
      : (manifest.acceptedDiagnosticFormats ?? [manifest.diagnosticFormat]);
  if (
    !acceptedDiagnosticFormats.some(
      (format) => format === request.evidence.diagnosticFormat,
    )
  ) {
    reasons.push(reason("UNSUPPORTED_DIAGNOSTIC", rule.id, evidenceIds));
  }
  if (rule.adapterId === null || !ACTION_CATALOG[request.action.type].executable) {
    reasons.push(reason("CATALOG_REFUSAL", rule.id, evidenceIds));
  } else if (request.target.adapterId !== rule.adapterId) {
    reasons.push(reason("ADAPTER_MISMATCH", rule.id, evidenceIds));
  }
  if (rule.allowedEnvironment === null || request.target.environment !== rule.allowedEnvironment) {
    reasons.push(reason("ENVIRONMENT_MISMATCH", rule.id, evidenceIds));
  }
  if (request.target.resourceId !== request.action.laneId) {
    reasons.push(reason("TARGET_MISMATCH", rule.id, evidenceIds));
  }
  if (
    rule.classification === "green" &&
    (ACTION_CATALOG[request.action.type].mutates || request.target.environment !== "read_only")
  ) {
    reasons.push(reason("GREEN_MUTATION_MISMATCH", rule.id, evidenceIds));
  }
  const present = new Set(evidence.presentRecordIds);
  if (evidenceIds.some((recordId) => !present.has(recordId))) {
    reasons.push(reason("EVIDENCE_MISSING", rule.id, evidenceIds));
  }
  if (evidenceIds.some((recordId) => evidence.qualityByRecordId[recordId] !== "valid")) {
    reasons.push(reason("EVIDENCE_INVALID", rule.id, evidenceIds));
  }
  if (rule.requiredEvidenceOutcome && evidence.outcome !== rule.requiredEvidenceOutcome) {
    reasons.push(reason("EVIDENCE_OUTCOME_MISMATCH", rule.id, evidenceIds));
  }
  if (!evidence.assessmentMatchesRawEvidence) {
    reasons.push(reason("ASSESSMENT_MISMATCH", rule.id, evidenceIds));
  }

  let classification = rule.classification;
  let disposition: PolicyDecision["disposition"];
  if (reasons.length > 0 || classification === "red") {
    classification = "red";
    disposition = "refuse";
    if (reasons.length === 0) reasons.push(reason("RED_ACTION_REFUSED", rule.id, evidenceIds));
  } else if (classification === "yellow") {
    disposition = "approval_required";
    reasons.push(reason("APPROVAL_REQUIRED", rule.id, evidenceIds));
  } else {
    disposition = "allow";
    reasons.push(reason("ACTION_ALLOWED", rule.id, evidenceIds));
  }

  const actionHash = actionDigest(request);
  const decisionAt = clock.now().toISOString();
  const partial = {
    schemaVersion: DECISION_VERSION,
    id: `decision-${actionHash.slice(0, 16)}`,
    requestId: request.id,
    actionDigest: actionHash,
    policy: { id: manifest.id, version: manifest.version },
    classification,
    disposition,
    reasonCodes: reasons.map((item) => item.code),
    reasons,
    requirements:
      disposition === "approval_required"
        ? ["exact_human_approval", "fresh_evidence", "passing_precondition", "authorized_compensation"]
        : [],
    decisionAt,
    decisionDigest: "0".repeat(64),
  } satisfies PolicyDecision;
  partial.decisionDigest = digestOmitting(partial, "decisionDigest");
  return policyDecisionSchema.parse(partial);
}

export function parsePolicy(input: unknown): PolicyManifest {
  return policyManifestSchema.parse(input);
}
