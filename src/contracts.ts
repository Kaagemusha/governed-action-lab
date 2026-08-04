import { z } from "zod";

export const REQUEST_VERSION = "governed-action-request/v1";
export const DECISION_VERSION = "governed-action-decision/v1";
export const APPROVAL_VERSION = "governed-action-approval/v1";
export const RECEIPT_VERSION = "governed-action-receipt/v1";
export const POLICY_VERSION = "governed-action-policy/v1";
export const DIAGNOSTIC_VERSION = "context-layer-diagnostic/v1";
export const REVIEW_VERSION = "governed-action-review/v1";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });

export const inspectActionSchema = z
  .object({
    type: z.literal("inspect_run_receipt"),
    laneId: id,
    recordId: id,
  })
  .strict();
export const retryActionSchema = z
  .object({
    type: z.literal("retry_failed_lane"),
    laneId: id,
    recordId: id,
    retryPayloadHash: digest,
    simulateFailure: z.enum(["none", "before_effect", "after_effect"]).default("none"),
  })
  .strict();
export const deleteActionSchema = z
  .object({
    type: z.literal("delete_preserved_output"),
    laneId: id,
    recordId: id,
  })
  .strict();
export const catalogActionSchema = z.discriminatedUnion("type", [
  inspectActionSchema,
  retryActionSchema,
  deleteActionSchema,
]);
export const catalogActionTypeSchema = z.enum([
  "inspect_run_receipt",
  "retry_failed_lane",
  "delete_preserved_output",
]);

export const actionRequestSchema = z
  .object({
    schemaVersion: z.literal(REQUEST_VERSION),
    id,
    idempotencyKey: id,
    proposedAt: instant,
    proposer: z
      .object({ kind: z.enum(["agent", "operator", "automation"]), id })
      .strict(),
    intent: id,
    action: catalogActionSchema,
    target: z
      .object({
        adapterId: id,
        resourceId: id,
        environment: id,
      })
      .strict(),
    evidence: z
      .object({
        diagnosticFormat: id,
        diagnosticHash: digest,
        recordIds: z.array(id).min(1),
        asOf: instant,
      })
      .strict(),
    expectedState: z
      .object({
        resourceVersion: id.optional(),
        contentHash: digest.optional(),
      })
      .strict()
      .refine((value) => value.resourceVersion || value.contentHash, {
        message: "Expected state requires a resource version or content hash.",
      }),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.evidence.recordIds).size !== value.evidence.recordIds.length) {
      context.addIssue({
        code: "custom",
        path: ["evidence", "recordIds"],
        message: "Evidence record IDs must be unique.",
      });
    }
  });

export const policyReasonSchema = z
  .object({
    code: id,
    message: id,
    evidenceRecordIds: z.array(id),
    policyRuleId: id,
  })
  .strict();

export const policyDecisionSchema = z
  .object({
    schemaVersion: z.literal(DECISION_VERSION),
    id,
    requestId: id,
    actionDigest: digest,
    policy: z.object({ id, version: id }).strict(),
    classification: z.enum(["green", "yellow", "red"]),
    disposition: z.enum(["allow", "approval_required", "refuse"]),
    reasonCodes: z.array(id).min(1),
    reasons: z.array(policyReasonSchema).min(1),
    requirements: z.array(id),
    decisionAt: instant,
    decisionDigest: digest,
  })
  .strict();

export const actionPlanSchema = z
  .object({
    effect: id,
    reversible: z.boolean(),
  })
  .strict();

export const actionReviewSchema = z
  .object({
    schemaVersion: z.literal(REVIEW_VERSION),
    id,
    diagnostic: z
      .object({
        format: z.literal(DIAGNOSTIC_VERSION),
        digest,
        asOf: instant,
      })
      .strict(),
    request: actionRequestSchema,
    decision: policyDecisionSchema,
    plan: actionPlanSchema,
    status: z.enum(["READY", "APPROVAL_REQUIRED", "REFUSED"]),
    reviewDigest: digest,
  })
  .strict();

export const approvalGrantSchema = z
  .object({
    schemaVersion: z.literal(APPROVAL_VERSION),
    id,
    actionDigest: digest,
    decisionDigest: digest,
    approvedBy: id,
    approvedAt: instant,
    expiresAt: instant,
    singleUse: z.literal(true),
    failureCompensationAuthorized: z.literal(true),
    grantDigest: digest,
  })
  .strict();

export const effectSchema = z
  .object({
    kind: id,
    resourceId: id,
    beforeHash: digest,
    afterHash: digest,
  })
  .strict();

export const executionReceiptSchema = z
  .object({
    schemaVersion: z.literal(RECEIPT_VERSION),
    id,
    requestId: id,
    actionDigest: digest,
    decisionDigest: digest,
    approvalId: id.nullable(),
    adapter: z.object({ id, version: id }).strict(),
    startedAt: instant,
    endedAt: instant,
    result: z.enum(["succeeded", "refused", "stale", "expired", "failed", "compensated"]),
    preconditionCheck: z.object({ passed: z.boolean(), detail: id }).strict(),
    effects: z.array(effectSchema),
    verification: z.object({ passed: z.boolean(), detail: id }).strict(),
    compensation: z
      .object({
        supported: z.boolean(),
        authorized: z.boolean(),
        attempted: z.boolean(),
        result: z.enum(["not_needed", "not_authorized", "succeeded", "failed"]),
      })
      .strict(),
    previousReceiptId: id.nullable(),
    receiptDigest: digest,
  })
  .strict();

export const policyRuleSchema = z
  .object({
    id,
    actionType: z.enum([
      "inspect_run_receipt",
      "retry_failed_lane",
      "delete_preserved_output",
    ]),
    adapterId: id.nullable(),
    classification: z.enum(["green", "yellow", "red"]),
    allowedEnvironment: z.enum(["read_only", "synthetic_sandbox"]).nullable(),
    approvalRequired: z.boolean(),
    maxApprovalLifetimeSeconds: z.number().int().positive().nullable(),
    requiredEvidenceOutcome: z.enum(["success", "failed", "preserved_local"]).nullable(),
    reversible: z.boolean(),
    verificationRequired: z.boolean(),
  })
  .strict();

export const policyManifestSchema = z
  .object({
    schemaVersion: z.literal(POLICY_VERSION),
    id,
    version: id,
    diagnosticFormat: z.literal(DIAGNOSTIC_VERSION),
    maxEvidenceAgeSeconds: z.number().int().positive(),
    rules: z.array(policyRuleSchema).length(3),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.rules.map((rule) => rule.id);
    const actions = value.rules.map((rule) => rule.actionType);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", path: ["rules"], message: "Rule IDs must be unique." });
    }
    if (new Set(actions).size !== actions.length) {
      context.addIssue({ code: "custom", path: ["rules"], message: "Action types must be unique." });
    }
  });

const validationIssueSchema = z
  .object({
    code: z.enum(["malformed_record", "missing_provenance", "stale_record", "unsupported_claim"]),
    severity: z.enum(["error", "warning"]),
    message: id,
    path: id.optional(),
  })
  .strict();
const contextRecordSchema = z
  .object({
    id,
    title: id,
    summary: id,
    content: id,
    tags: z.array(id),
    owner: id,
    updatedAt: instant,
    validUntil: instant,
    sources: z.array(z.object({ id, label: id, url: z.string().url(), observedAt: instant }).strict()),
    claims: z.array(z.object({ text: id, sourceIds: z.array(id) }).strict()),
  })
  .strict();
const laneSchema = z.object({ id, label: id, dueAt: instant }).strict();
const scenarioReceiptSchema = z
  .object({
    recordId: id,
    laneId: id,
    observedAt: instant,
    outcome: z.enum(["success", "failed", "preserved_local"]),
  })
  .strict();
const laneAssessmentSchema = z
  .object({
    id,
    label: id,
    state: z.enum(["healthy", "attention", "missing", "not_due"]),
    outcome: z.enum(["success", "failed", "preserved_local"]).nullable(),
    evidenceRecordId: id.nullable(),
  })
  .strict();

export const diagnosticSnapshotSchema = z
  .object({
    format: z.literal(DIAGNOSTIC_VERSION),
    scenario: z
      .object({
        question: id,
        asOf: instant,
        lanes: z.array(laneSchema).min(1),
        summary: z.object({ recordId: id, observedAt: instant, verdict: z.enum(["healthy", "attention"]) }).strict(),
        receipts: z.array(scenarioReceiptSchema),
      })
      .strict(),
    assessment: z
      .object({
        question: id,
        asOf: instant,
        naiveVerdict: z.enum(["healthy", "attention"]),
        governedVerdict: z.enum(["healthy", "attention"]),
        summaryStale: z.boolean(),
        decisionPrevented: z.boolean(),
        newerEvidenceRecordIds: z.array(id),
        laneAssessments: z.array(laneAssessmentSchema),
        evidenceQuality: z.record(
          id,
          z.object({ state: z.enum(["valid", "degraded", "invalid"]), issues: z.array(validationIssueSchema) }).strict(),
        ),
      })
      .strict(),
    records: z.array(contextRecordSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.records.map((record) => record.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", path: ["records"], message: "Record IDs must be unique." });
    }
  });

export type CatalogAction = z.infer<typeof catalogActionSchema>;
export type ActionRequest = z.infer<typeof actionRequestSchema>;
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
export type ApprovalGrant = z.infer<typeof approvalGrantSchema>;
export type ExecutionReceipt = z.infer<typeof executionReceiptSchema>;
export type PolicyManifest = z.infer<typeof policyManifestSchema>;
export type DiagnosticSnapshot = z.infer<typeof diagnosticSnapshotSchema>;
export type ActionReview = z.infer<typeof actionReviewSchema>;
