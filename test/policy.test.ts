import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { ActionRequest, PolicyManifest } from "../src/contracts.js";
import { evaluateAction } from "../src/policy.js";

const policy = JSON.parse(await readFile("data/policy.json", "utf8")) as PolicyManifest;
const hash = "a".repeat(64);
const base: ActionRequest = {
  schemaVersion: "governed-action-request/v1",
  id: "request-1",
  idempotencyKey: "key-1",
  proposedAt: "2026-07-28T09:11:00Z",
  proposer: { kind: "agent", id: "demo" },
  intent: "Inspect",
  action: { type: "inspect_run_receipt", laneId: "site-refresh", recordId: "receipt" },
  target: { adapterId: "synthetic-automation", resourceId: "site-refresh", environment: "read_only" },
  evidence: {
    diagnosticFormat: "context-layer-diagnostic/v1",
    diagnosticHash: hash,
    recordIds: ["receipt"],
    asOf: "2026-07-28T09:10:00Z",
  },
  expectedState: { contentHash: hash },
};
const eligible = {
  presentRecordIds: ["receipt"],
  qualityByRecordId: { receipt: "valid" as const },
  outcome: "failed" as const,
  assessmentMatchesRawEvidence: true,
};
const clock = { now: () => new Date("2026-07-28T09:12:00Z") };

test("green inspection is allowed and deterministic", () => {
  const first = evaluateAction(base, policy, eligible, clock);
  const second = evaluateAction(base, policy, eligible, clock);
  assert.equal(first.classification, "green");
  assert.equal(first.disposition, "allow");
  assert.deepEqual(first, second);
});

test("yellow retry requires approval and reversibility", () => {
  const request: ActionRequest = {
    ...base,
    action: {
      type: "retry_failed_lane",
      laneId: "site-refresh",
      recordId: "receipt",
      retryPayloadHash: hash,
      simulateFailure: "none",
    },
    target: { ...base.target, environment: "synthetic_sandbox" },
  };
  const decision = evaluateAction(request, policy, eligible, clock);
  assert.equal(decision.classification, "yellow");
  assert.equal(decision.disposition, "approval_required");
  assert.ok(decision.requirements.includes("authorized_compensation"));
});

test("red deletion is structurally refused", () => {
  const request: ActionRequest = {
    ...base,
    action: { type: "delete_preserved_output", laneId: "research-watch", recordId: "receipt" },
    target: { adapterId: "synthetic-automation", resourceId: "research-watch", environment: "synthetic_sandbox" },
  };
  const decision = evaluateAction(request, policy, { ...eligible, outcome: "preserved_local" }, clock);
  assert.equal(decision.classification, "red");
  assert.equal(decision.disposition, "refuse");
});

test("unknown adapter, environment, policy, or invalid evidence fail closed", () => {
  const cases = [
    [{ ...base, target: { ...base.target, adapterId: "unknown" } }, policy, eligible, "ADAPTER_MISMATCH"],
    [{ ...base, target: { ...base.target, environment: "production" } }, policy, eligible, "ENVIRONMENT_MISMATCH"],
    [base, { ...policy, version: "future" }, eligible, "UNKNOWN_POLICY"],
    [base, policy, { ...eligible, qualityByRecordId: { receipt: "invalid" } }, "EVIDENCE_INVALID"],
  ] as const;
  for (const [request, manifest, evidence, code] of cases) {
    const decision = evaluateAction(request, manifest, evidence, clock);
    assert.equal(decision.disposition, "refuse");
    assert.ok(decision.reasonCodes.includes(code));
  }
});
