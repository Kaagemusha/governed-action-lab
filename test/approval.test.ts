import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileApprovalStore,
  MemoryApprovalStore,
  OperatorApprovalProvider,
  validateAndConsumeApproval,
} from "../src/approval.js";
import type { ActionRequest, PolicyDecision } from "../src/contracts.js";
import { actionDigest } from "../src/policy.js";

const hash = "a".repeat(64);
const request: ActionRequest = {
  schemaVersion: "governed-action-request/v1",
  id: "request",
  idempotencyKey: "key",
  proposedAt: "2026-07-28T09:10:00Z",
  proposer: { kind: "agent", id: "agent" },
  intent: "Retry",
  action: {
    type: "retry_failed_lane",
    laneId: "site-refresh",
    recordId: "receipt",
    retryPayloadHash: hash,
    simulateFailure: "none",
  },
  target: { adapterId: "synthetic-automation", resourceId: "site-refresh", environment: "synthetic_sandbox" },
  evidence: {
    diagnosticFormat: "context-layer-diagnostic/v1",
    diagnosticHash: hash,
    recordIds: ["receipt"],
    asOf: "2026-07-28T09:10:00Z",
  },
  expectedState: { contentHash: hash },
};
const decision: PolicyDecision = {
  schemaVersion: "governed-action-decision/v1",
  id: "decision",
  requestId: request.id,
  actionDigest: actionDigest(request),
  policy: { id: "governed-action-lab-public-policy", version: "1.0.0" },
  classification: "yellow",
  disposition: "approval_required",
  reasonCodes: ["APPROVAL_REQUIRED"],
  reasons: [{ code: "APPROVAL_REQUIRED", message: "Approval required.", evidenceRecordIds: ["receipt"], policyRuleId: "rule" }],
  requirements: ["exact_human_approval"],
  decisionAt: "2026-07-28T09:11:00Z",
  decisionDigest: "b".repeat(64),
};
const clock = { now: () => new Date("2026-07-28T09:12:00Z") };

test("approval binds request and decision and is single-use", async () => {
  const store = new MemoryApprovalStore();
  await new OperatorApprovalProvider(store, clock).issue(request, decision, "operator", true);
  assert.equal((await validateAndConsumeApproval(store, request, decision, clock)).valid, true);
  assert.deepEqual(await validateAndConsumeApproval(store, request, decision, clock), { valid: false, code: "replayed" });
});

test("changed request, decision, expiry, and tampering refuse", async () => {
  const store = new MemoryApprovalStore();
  const grant = await new OperatorApprovalProvider(store, clock).issue(request, decision, "operator", true, 10);
  assert.deepEqual(
    await validateAndConsumeApproval(store, { ...request, intent: "changed" }, decision, clock),
    { valid: false, code: "missing" },
  );
  assert.deepEqual(
    await validateAndConsumeApproval(store, request, { ...decision, decisionDigest: "c".repeat(64) }, clock),
    { valid: false, code: "missing" },
  );
  const expiredClock = { now: () => new Date("2026-07-28T09:13:00Z") };
  assert.deepEqual(await validateAndConsumeApproval(store, request, decision, expiredClock), { valid: false, code: "expired" });
  store.grants.set(grant.id, { ...grant, approvedBy: "tampered" });
  assert.deepEqual(await validateAndConsumeApproval(store, request, decision, clock), { valid: false, code: "tampered" });
});

test("file approval storage is restrictive and parseable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "governed-approval-"));
  const path = join(directory, "approvals.json");
  const store = new FileApprovalStore(path);
  await new OperatorApprovalProvider(store, clock).issue(request, decision, "operator", true);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const contents = await readFile(path, "utf8");
  assert.doesNotThrow(() => JSON.parse(contents));
});

test("operator provider cannot approve green or red decisions", async () => {
  const provider = new OperatorApprovalProvider(new MemoryApprovalStore(), clock);
  await assert.rejects(
    provider.issue(request, { ...decision, classification: "red", disposition: "refuse" }, "operator", true),
  );
});
