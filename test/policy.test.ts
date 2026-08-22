import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { ActionRequest, PolicyManifest } from "../src/contracts.js";
import { sha256 } from "../src/canonical.js";
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
  target: { adapterId: "governed-automation", resourceId: "site-refresh", environment: "read_only" },
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

test("policy accepts v1 and v2 diagnostics but refuses unknown formats", () => {
  for (const diagnosticFormat of [
    "context-layer-diagnostic/v1",
    "context-layer-diagnostic/v2",
  ]) {
    const decision = evaluateAction(
      {
        ...base,
        evidence: { ...base.evidence, diagnosticFormat },
      },
      policy,
      eligible,
      clock,
    );
    assert.equal(decision.disposition, "allow");
  }
  const refused = evaluateAction(
    {
      ...base,
      evidence: {
        ...base.evidence,
        diagnosticFormat: "context-layer-diagnostic/v3",
      },
    },
    policy,
    eligible,
    clock,
  );
  assert.equal(refused.disposition, "refuse");
  assert.ok(refused.reasonCodes.includes("UNSUPPORTED_DIAGNOSTIC"));
});

test("legacy public policy 1.1 remains v1-only", () => {
  const {
    acceptedDiagnosticFormats: _acceptedDiagnosticFormats,
    ...legacyPolicy
  } = policy;
  const manifest = {
    ...legacyPolicy,
    version: "1.1.0",
    diagnosticFormat: "context-layer-diagnostic/v1" as const,
  };
  const v1 = evaluateAction(base, manifest, eligible, clock);
  assert.equal(v1.disposition, "allow");

  const v2 = evaluateAction(
    {
      ...base,
      evidence: {
        ...base.evidence,
        diagnosticFormat: "context-layer-diagnostic/v2",
      },
    },
    manifest,
    eligible,
    clock,
  );
  assert.equal(v2.disposition, "refuse");
  assert.ok(v2.reasonCodes.includes("UNSUPPORTED_DIAGNOSTIC"));
  assert.throws(
    () =>
      evaluateAction(
        base,
        { ...policy, version: "1.1.0" },
        eligible,
        clock,
      ),
    /Public policy 1\.1\.0 is v1-only/,
  );
});

test("policy versions lock their declared default while retaining compatible reads", () => {
  assert.throws(
    () => evaluateAction(base, { ...policy, version: "1.2.0" }, eligible, clock),
    /Public policy 1\.2\.0 must accept exactly diagnostic v1 and v2/,
  );
  assert.throws(
    () =>
      evaluateAction(
        base,
        { ...policy, diagnosticFormat: "context-layer-diagnostic/v1" },
        eligible,
        clock,
      ),
    /Public policy 1\.3\.0 must default to diagnostic v2/,
  );
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
    target: { adapterId: "governed-automation", resourceId: "research-watch", environment: "synthetic_sandbox" },
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

test("a non-public host policy requires an exact digest-pinned trust binding", () => {
  const hostPolicy: PolicyManifest = {
    ...policy,
    id: "host-policy",
    version: "1",
    rules: policy.rules.map((rule) => ({
      ...rule,
      allowedResourceIds: ["site-refresh"],
    })),
  };
  const untrusted = evaluateAction(base, hostPolicy, eligible, clock);
  assert.equal(untrusted.disposition, "refuse");
  assert.ok(untrusted.reasonCodes.includes("UNKNOWN_POLICY"));

  const trust = {
    id: hostPolicy.id,
    version: hostPolicy.version,
    manifestDigest: sha256(hostPolicy),
  };
  const trusted = evaluateAction(base, hostPolicy, eligible, clock, trust);
  assert.equal(trusted.disposition, "allow");
  assert.equal(trusted.policy.manifestDigest, trust.manifestDigest);

  const tamperedPolicy = {
    ...hostPolicy,
    maxEvidenceAgeSeconds: hostPolicy.maxEvidenceAgeSeconds + 1,
  };
  const tampered = evaluateAction(base, tamperedPolicy, eligible, clock, trust);
  assert.equal(tampered.disposition, "refuse");
  assert.ok(tampered.reasonCodes.includes("UNKNOWN_POLICY"));

  const tamperedTrust = {
    ...trust,
    manifestDigest: sha256(tamperedPolicy),
  };
  const replaced = evaluateAction(base, tamperedPolicy, eligible, clock, tamperedTrust);
  assert.notEqual(replaced.decisionDigest, trusted.decisionDigest);
  assert.notEqual(replaced.policy.manifestDigest, trusted.policy.manifestDigest);
});

test("resource allowlists reject lane substitution under an otherwise trusted policy", () => {
  const hostPolicy: PolicyManifest = {
    ...policy,
    id: "host-policy",
    version: "1",
    rules: policy.rules.map((rule) => ({
      ...rule,
      allowedResourceIds: ["site-refresh"],
    })),
  };
  const trust = {
    id: hostPolicy.id,
    version: hostPolicy.version,
    manifestDigest: sha256(hostPolicy),
  };
  const substituted: ActionRequest = {
    ...base,
    action: { ...base.action, laneId: "other-lane" },
    target: { ...base.target, resourceId: "other-lane" },
  };
  const decision = evaluateAction(substituted, hostPolicy, eligible, clock, trust);
  assert.equal(decision.disposition, "refuse");
  assert.ok(decision.reasonCodes.includes("TARGET_NOT_ALLOWED"));
});
