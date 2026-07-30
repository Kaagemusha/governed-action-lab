import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, digestOmitting, sha256 } from "../src/canonical.js";
import {
  actionRequestSchema,
  policyManifestSchema,
  type ActionRequest,
} from "../src/contracts.js";

const digest = "a".repeat(64);
const request: ActionRequest = {
  schemaVersion: "governed-action-request/v1",
  id: "request-1",
  idempotencyKey: "once-1",
  proposedAt: "2026-07-28T09:11:00Z",
  proposer: { kind: "agent", id: "demo-agent" },
  intent: "Inspect the failed receipt",
  action: { type: "inspect_run_receipt", laneId: "site-refresh", recordId: "site-refresh-receipt" },
  target: { adapterId: "synthetic-automation", resourceId: "site-refresh", environment: "read_only" },
  evidence: {
    diagnosticFormat: "context-layer-diagnostic/v1",
    diagnosticHash: digest,
    recordIds: ["site-refresh-receipt"],
    asOf: "2026-07-28T09:10:00Z",
  },
  expectedState: { contentHash: digest },
};

test("canonical JSON sorts keys recursively and hashes deterministically", () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
  assert.equal(sha256(request), sha256(structuredClone(request)));
  assert.notEqual(sha256(request), sha256({ ...request, intent: "Changed" }));
});

test("portable SHA-256 matches the standard vector", () => {
  assert.equal(sha256("abc"), "6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25");
});

test("canonical JSON rejects non-JSON values", () => {
  assert.throws(() => canonicalJson({ bad: undefined }), /Undefined value/);
  assert.throws(() => canonicalJson({ bad: Number.NaN }), /Non-finite number/);
  assert.throws(() => canonicalJson({ bad: 1n }), /Non-JSON value/);
});

test("request schema is strict and reports precise paths", () => {
  const invalid = actionRequestSchema.safeParse({ ...request, surprise: true });
  assert.equal(invalid.success, false);
  if (!invalid.success) assert.deepEqual(invalid.error.issues[0]?.path, []);
});

test("unknown action and duplicate evidence IDs are rejected", () => {
  assert.equal(
    actionRequestSchema.safeParse({ ...request, action: { type: "run_shell", command: "rm" } }).success,
    false,
  );
  assert.equal(
    actionRequestSchema.safeParse({
      ...request,
      evidence: { ...request.evidence, recordIds: ["a", "a"] },
    }).success,
    false,
  );
});

test("policy rejects duplicate rule IDs and action types", () => {
  const rule = {
    id: "same",
    actionType: "inspect_run_receipt" as const,
    adapterId: "synthetic-automation",
    classification: "green" as const,
    allowedEnvironment: "read_only" as const,
    approvalRequired: false,
    maxApprovalLifetimeSeconds: null,
    requiredEvidenceOutcome: null,
    reversible: false,
    verificationRequired: true,
  };
  const parsed = policyManifestSchema.safeParse({
    schemaVersion: "governed-action-policy/v1",
    id: "policy",
    version: "1",
    diagnosticFormat: "context-layer-diagnostic/v1",
    maxEvidenceAgeSeconds: 3600,
    rules: [rule, rule, rule],
  });
  assert.equal(parsed.success, false);
});

test("digest omission excludes only the requested digest field", () => {
  const value = { id: "x", digest: "placeholder", nested: { a: 1 } };
  assert.equal(digestOmitting(value, "digest"), sha256({ id: "x", nested: { a: 1 } }));
});
