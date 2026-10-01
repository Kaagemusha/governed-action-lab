import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { ActionRequest, PolicyManifest } from "../src/contracts.js";
import { sha256 } from "../src/canonical.js";
import { PUBLIC_POLICY_DIGESTS, evaluateAction } from "../src/policy.js";
import { policyManifestSchema } from "../src/contracts.js";

const policy = JSON.parse(await readFile("data/policy.json", "utf8")) as PolicyManifest;
const hash = "a".repeat(64);
const base: ActionRequest = {
  schemaVersion: "governed-action-request/v1",
  id: "request-1",
  idempotencyKey: "key-1",
  proposedAt: "2026-07-28T09:11:00Z",
  proposer: { kind: "agent", id: "demo" },
  intent: "Inspect",
  action: { type: "inspect_run_receipt", laneId: "docs-build", recordId: "receipt" },
  target: { adapterId: "governed-automation", resourceId: "docs-build", environment: "read_only" },
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
      laneId: "docs-build",
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
    action: { type: "delete_preserved_output", laneId: "weekly-report", recordId: "receipt" },
    target: { adapterId: "governed-automation", resourceId: "weekly-report", environment: "synthetic_sandbox" },
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
      allowedResourceIds: ["docs-build"],
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
      allowedResourceIds: ["docs-build"],
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

test("host policies bind the exact host adapter and reversible environment", () => {
  const request: ActionRequest = {
    ...base,
    action: {
      type: "retry_failed_lane",
      laneId: "docs-build",
      recordId: "receipt",
      retryPayloadHash: hash,
      simulateFailure: "none",
    },
    target: {
      adapterId: "host-adapter",
      resourceId: "docs-build",
      environment: "host_local_reversible",
    },
  };
  const hostPolicy: PolicyManifest = {
    ...policy,
    id: "host-policy",
    version: "1",
    rules: policy.rules.map((rule) =>
      rule.actionType === "retry_failed_lane"
        ? {
            ...rule,
            adapterId: "host-adapter",
            allowedEnvironment: "host_local_reversible",
            allowedResourceIds: ["docs-build"],
          }
        : rule,
    ),
  };
  const trust = {
    id: hostPolicy.id,
    version: hostPolicy.version,
    manifestDigest: sha256(hostPolicy),
  };
  assert.equal(
    evaluateAction(request, hostPolicy, eligible, clock, trust).disposition,
    "approval_required",
  );
  for (const target of [
    { ...request.target, adapterId: "other-adapter" },
    { ...request.target, environment: "synthetic_sandbox" },
  ]) {
    assert.equal(
      evaluateAction({ ...request, target }, hostPolicy, eligible, clock, trust)
        .disposition,
      "refuse",
    );
  }
});

test("public policy trust is pinned to exact manifest content, not id and version", () => {
  assert.equal(sha256(policyManifestSchema.parse(policy)), PUBLIC_POLICY_DIGESTS[policy.version]);
  const genuine = evaluateAction(base, policy, eligible, clock);
  assert.equal(genuine.disposition, "allow");
  assert.equal(genuine.policy.manifestDigest, PUBLIC_POLICY_DIGESTS[policy.version]);

  const impersonated = {
    ...policy,
    maxEvidenceAgeSeconds: 10 * 365 * 24 * 60 * 60,
  };
  const refused = evaluateAction(base, impersonated, eligible, clock);
  assert.equal(refused.policy.id, policy.id);
  assert.equal(refused.policy.version, policy.version);
  assert.equal(refused.disposition, "refuse");
  assert.ok(refused.reasonCodes.includes("UNKNOWN_POLICY"));
  assert.equal(refused.policy.manifestDigest, undefined);
});

test("rule flags must agree with the classification the executor enforces", () => {
  const withRule = (actionType: string, patch: Record<string, unknown>) => ({
    ...policy,
    rules: policy.rules.map((rule) =>
      rule.actionType === actionType ? { ...rule, ...patch } : rule,
    ),
  });
  assert.ok(policyManifestSchema.safeParse(policy).success);
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["retry_failed_lane", { approvalRequired: false }, "approvalRequired"],
    ["inspect_run_receipt", { approvalRequired: true }, "approvalRequired"],
    ["retry_failed_lane", { reversible: false }, "reversible"],
    ["delete_preserved_output", { reversible: true }, "reversible"],
    ["retry_failed_lane", { verificationRequired: false }, "verificationRequired"],
    ["inspect_run_receipt", { verificationRequired: false }, "verificationRequired"],
    ["delete_preserved_output", { verificationRequired: true }, "verificationRequired"],
  ];
  for (const [actionType, patch, field] of cases) {
    const result = policyManifestSchema.safeParse(withRule(actionType, patch));
    assert.equal(result.success, false, `${actionType} ${JSON.stringify(patch)}`);
    assert.ok(result.error!.issues.some((issue) => issue.path.includes(field)));
  }
});
