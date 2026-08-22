import { z } from "zod";

export const REQUEST_VERSION = "governed-action-request/v1";
export const DECISION_VERSION = "governed-action-decision/v1";
export const APPROVAL_VERSION = "governed-action-approval/v1";
export const RECEIPT_VERSION = "governed-action-receipt/v1";
export const POLICY_VERSION = "governed-action-policy/v1";
export const DIAGNOSTIC_VERSION = "context-layer-diagnostic/v1";
export const DIAGNOSTIC_V2_VERSION = "context-layer-diagnostic/v2";
export const REVIEW_VERSION = "governed-action-review/v1";
export const REVIEW_V2_VERSION = "governed-action-review/v2";
export const PROOF_VERSION = "governed-action-proof/v1";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
export const diagnosticVersionSchema = z.enum([
  DIAGNOSTIC_VERSION,
  DIAGNOSTIC_V2_VERSION,
]);

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
    policy: z.object({ id, version: id, manifestDigest: digest.optional() }).strict(),
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

const actionReviewShape = {
  id,
  request: actionRequestSchema,
  decision: policyDecisionSchema,
  plan: actionPlanSchema,
  status: z.enum(["READY", "APPROVAL_REQUIRED", "REFUSED"]),
  reviewDigest: digest,
};
const actionReviewV1Schema = z
  .object({
    schemaVersion: z.literal(REVIEW_VERSION),
    diagnostic: z
      .object({
        format: z.literal(DIAGNOSTIC_VERSION),
        digest,
        asOf: instant,
      })
      .strict(),
    ...actionReviewShape,
  })
  .strict();
export const actionReviewV2Schema = z
  .object({
    schemaVersion: z.literal(REVIEW_V2_VERSION),
    diagnostic: z
      .object({
        format: z.literal(DIAGNOSTIC_V2_VERSION),
        digest,
        asOf: instant,
      })
      .strict(),
    ...actionReviewShape,
  })
  .strict();
export const actionReviewSchema = z.discriminatedUnion("schemaVersion", [
  actionReviewV1Schema,
  actionReviewV2Schema,
]);

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
    allowedResourceIds: z.array(id).min(1).optional(),
    approvalRequired: z.boolean(),
    maxApprovalLifetimeSeconds: z.number().int().positive().nullable(),
    requiredEvidenceOutcome: z.enum(["success", "failed", "preserved_local"]).nullable(),
    reversible: z.boolean(),
    verificationRequired: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.allowedResourceIds &&
      new Set(value.allowedResourceIds).size !== value.allowedResourceIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowedResourceIds"],
        message: "Allowed resource IDs must be unique.",
      });
    }
  });

export const policyTrustBindingSchema = z
  .object({
    id,
    version: id,
    manifestDigest: digest,
  })
  .strict();

export const policyManifestSchema = z
  .object({
    schemaVersion: z.literal(POLICY_VERSION),
    id,
    version: id,
    diagnosticFormat: diagnosticVersionSchema,
    acceptedDiagnosticFormats: z.array(diagnosticVersionSchema).min(1).optional(),
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
    const accepted = value.acceptedDiagnosticFormats ?? [value.diagnosticFormat];
    if (new Set(accepted).size !== accepted.length) {
      context.addIssue({
        code: "custom",
        path: ["acceptedDiagnosticFormats"],
        message: "Accepted diagnostic formats must be unique.",
      });
    }
    if (!accepted.includes(value.diagnosticFormat)) {
      context.addIssue({
        code: "custom",
        path: ["acceptedDiagnosticFormats"],
        message: "Accepted diagnostic formats must include the default diagnostic format.",
      });
    }
    if (
      value.id === "governed-action-lab-public-policy" &&
      value.version === "1.1.0" &&
      (value.diagnosticFormat !== DIAGNOSTIC_VERSION ||
        accepted.length !== 1 ||
        accepted[0] !== DIAGNOSTIC_VERSION)
    ) {
      context.addIssue({
        code: "custom",
        path: ["acceptedDiagnosticFormats"],
        message: "Public policy 1.1.0 is v1-only.",
      });
    }
    if (
      value.id === "governed-action-lab-public-policy" &&
      value.version === "1.2.0" &&
      (value.diagnosticFormat !== DIAGNOSTIC_VERSION ||
        !accepted.includes(DIAGNOSTIC_VERSION) ||
        !accepted.includes(DIAGNOSTIC_V2_VERSION) ||
        accepted.length !== 2)
    ) {
      context.addIssue({
        code: "custom",
        path: ["acceptedDiagnosticFormats"],
        message: "Public policy 1.2.0 must accept exactly diagnostic v1 and v2.",
      });
    }
    if (
      value.id === "governed-action-lab-public-policy" &&
      value.version === "1.3.0" &&
      (value.diagnosticFormat !== DIAGNOSTIC_V2_VERSION ||
        !accepted.includes(DIAGNOSTIC_VERSION) ||
        !accepted.includes(DIAGNOSTIC_V2_VERSION) ||
        accepted.length !== 2)
    ) {
      context.addIssue({
        code: "custom",
        path: ["acceptedDiagnosticFormats"],
        message: "Public policy 1.3.0 must default to diagnostic v2 and accept exactly v1 and v2.",
      });
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
const laneSchema = z.object({ id, label: id, dueAt: instant }).strict();
const operationalVerdictSchema = z.enum(["healthy", "attention"]);
const operationalOutcomeSchema = z.enum(["success", "failed", "preserved_local"]);
const sourceSchema = z
  .object({
    id,
    label: id,
    url: z.string().url(),
    observedAt: instant,
    contentHash: digest.optional(),
  })
  .strict();
const contextRecordShape = {
  id,
  title: id,
  summary: id,
  content: id,
  tags: z.array(id),
  owner: id,
  updatedAt: instant,
  validUntil: instant,
  sources: z.array(sourceSchema),
};
const contextRecordV1Schema = z
  .object({
    ...contextRecordShape,
    claims: z.array(z.object({ text: id, sourceIds: z.array(id) }).strict()),
  })
  .strict();
const operationalAssertionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("summary"),
      observedAt: instant,
      verdict: operationalVerdictSchema,
      lanes: z.array(laneSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("receipt"),
      laneId: id,
      observedAt: instant,
      outcome: operationalOutcomeSchema,
    })
    .strict(),
]);
const contextRecordV2Schema = z
  .object({
    ...contextRecordShape,
    claims: z.array(
      z
        .object({
          text: id,
          sourceIds: z.array(id),
          operational: operationalAssertionSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict();
const scenarioReceiptSchema = z
  .object({
    recordId: id,
    laneId: id,
    observedAt: instant,
    outcome: z.enum(["success", "failed", "preserved_local"]),
  })
  .strict();
const scenarioSchema = z
  .object({
    question: id,
    asOf: instant,
    lanes: z.array(laneSchema).min(1),
    summary: z
      .object({
        recordId: id,
        observedAt: instant,
        verdict: operationalVerdictSchema,
      })
      .strict(),
    receipts: z.array(scenarioReceiptSchema),
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
const assessmentSchema = z
  .object({
    question: id,
    asOf: instant,
    naiveVerdict: operationalVerdictSchema,
    governedVerdict: operationalVerdictSchema,
    summaryStale: z.boolean(),
    decisionPrevented: z.boolean(),
    newerEvidenceRecordIds: z.array(id),
    laneAssessments: z.array(laneAssessmentSchema),
    evidenceQuality: z.record(
      id,
      z
        .object({
          state: z.enum(["valid", "degraded", "invalid"]),
          issues: z.array(validationIssueSchema),
        })
        .strict(),
    ),
  })
  .strict();

export const diagnosticSnapshotV1Schema = z
  .object({
    format: z.literal(DIAGNOSTIC_VERSION),
    scenario: scenarioSchema,
    assessment: assessmentSchema,
    records: z.array(contextRecordV1Schema),
  })
  .strict();
export const diagnosticSnapshotV2Schema = z
  .object({
    format: z.literal(DIAGNOSTIC_V2_VERSION),
    scenario: scenarioSchema,
    assessment: assessmentSchema,
    records: z.array(contextRecordV2Schema),
  })
  .strict();

type ExpectedOperationalAssertion =
  | {
      kind: "summary";
      observedAt: string;
      verdict: "healthy" | "attention";
      lanes: z.infer<typeof laneSchema>[];
    }
  | {
      kind: "receipt";
      laneId: string;
      observedAt: string;
      outcome: "success" | "failed" | "preserved_local";
    };

export const diagnosticSnapshotSchema = z
  .discriminatedUnion("format", [
    diagnosticSnapshotV1Schema,
    diagnosticSnapshotV2Schema,
  ])
  .superRefine((value, context) => {
    const ids = value.records.map((record) => record.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", path: ["records"], message: "Record IDs must be unique." });
    }
    if (value.format !== DIAGNOSTIC_V2_VERSION) return;

    const checkBinding = (
      recordId: string,
      expected: ExpectedOperationalAssertion,
      path: PropertyKey[],
    ) => {
      const record = value.records.find((candidate) => candidate.id === recordId);
      if (!record) {
        context.addIssue({
          code: "custom",
          path,
          message: `Operational evidence record "${recordId}" is absent.`,
        });
        return;
      }
      const operationalClaims = record.claims.filter(
        (claim) => claim.operational !== undefined,
      );
      if (operationalClaims.length !== 1) {
        context.addIssue({
          code: "custom",
          path,
          message: `Operational evidence record "${recordId}" must contain exactly one typed operational assertion.`,
        });
        return;
      }
      const claim = operationalClaims[0]!;
      const assertion = claim.operational!;
      if (
        !claim.sourceIds.some((sourceId) =>
          record.sources.some(
            (source) =>
              source.id === sourceId &&
              source.observedAt === assertion.observedAt,
          ),
        )
      ) {
        context.addIssue({
          code: "custom",
          path,
          message: `Typed operational assertion for record "${recordId}" is not bound to a source at its observation time.`,
        });
        return;
      }

      let matches = false;
      if (assertion.kind === "summary" && expected.kind === "summary") {
        matches =
          assertion.observedAt === expected.observedAt &&
          assertion.verdict === expected.verdict &&
          assertion.lanes.length === expected.lanes.length &&
          assertion.lanes.every((lane, index) => {
            const expectedLane = expected.lanes[index];
            return (
              expectedLane !== undefined &&
              lane.id === expectedLane.id &&
              lane.label === expectedLane.label &&
              lane.dueAt === expectedLane.dueAt
            );
          });
      } else if (assertion.kind === "receipt" && expected.kind === "receipt") {
        matches =
          assertion.laneId === expected.laneId &&
          assertion.observedAt === expected.observedAt &&
          assertion.outcome === expected.outcome;
      }
      if (!matches) {
        context.addIssue({
          code: "custom",
          path,
          message: `Scenario ${expected.kind} for record "${recordId}" does not match its typed operational assertion.`,
        });
      }
    };

    checkBinding(
      value.scenario.summary.recordId,
      {
        kind: "summary",
        observedAt: value.scenario.summary.observedAt,
        verdict: value.scenario.summary.verdict,
        lanes: value.scenario.lanes,
      },
      ["scenario", "summary"],
    );
    value.scenario.receipts.forEach((receipt, index) => {
      checkBinding(
        receipt.recordId,
        {
          kind: "receipt",
          laneId: receipt.laneId,
          observedAt: receipt.observedAt,
          outcome: receipt.outcome,
        },
        ["scenario", "receipts", index],
      );
    });
  });

export const proofPacketSchema = z
  .object({
    schemaVersion: z.literal(PROOF_VERSION),
    mode: z.literal("synthetic_green_inspection"),
    synthetic: z.literal(true),
    diagnosticSource: z
      .object({
        producer: id,
        producerCommit: z.string().regex(/^[a-f0-9]{40}$/),
        producerArtifact: id,
        format: z.literal(DIAGNOSTIC_V2_VERSION),
        fixtureSha256: digest,
        diagnosticCanonicalSha256: digest,
      })
      .strict(),
    diagnostic: diagnosticSnapshotV2Schema,
    policy: policyManifestSchema,
    review: actionReviewV2Schema,
    approvalBoundary: z
      .object({ required: z.literal(false), grant: z.null() })
      .strict(),
    receipt: executionReceiptSchema,
    packetDigest: digest,
  })
  .strict();

export type CatalogAction = z.infer<typeof catalogActionSchema>;
export type ActionRequest = z.infer<typeof actionRequestSchema>;
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
export type ApprovalGrant = z.infer<typeof approvalGrantSchema>;
export type ExecutionReceipt = z.infer<typeof executionReceiptSchema>;
export type PolicyManifest = z.infer<typeof policyManifestSchema>;
export type PolicyTrustBinding = z.infer<typeof policyTrustBindingSchema>;
export type DiagnosticSnapshot = z.infer<typeof diagnosticSnapshotSchema>;
export type DiagnosticSnapshotV1 = z.infer<typeof diagnosticSnapshotV1Schema>;
export type ActionReview = z.infer<typeof actionReviewSchema>;
export type DiagnosticSnapshotV2 = z.infer<typeof diagnosticSnapshotV2Schema>;
export type ProofPacket = z.infer<typeof proofPacketSchema>;
