import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  proposeActionFromDiagnostic,
  recheckProposal,
} from "../src/context-adapter.js";

const fixture = JSON.parse(await readFile("examples/context-layer-diagnostic.json", "utf8")) as Record<string, unknown>;
const v2Fixture = JSON.parse(
  await readFile("examples/context-layer-diagnostic-v2.json", "utf8"),
) as Record<string, unknown>;

test("diagnostic creates exact green, yellow, and red requests", () => {
  const inspect = proposeActionFromDiagnostic(fixture, { actionType: "inspect_run_receipt", laneId: "site-refresh" });
  const retry = proposeActionFromDiagnostic(fixture, { actionType: "retry_failed_lane", laneId: "site-refresh" });
  const deletion = proposeActionFromDiagnostic(fixture, { actionType: "delete_preserved_output", laneId: "research-watch" });
  assert.equal(inspect.request.target.environment, "read_only");
  assert.equal(inspect.request.intent, "Inspect the latest run receipt.");
  assert.equal(retry.evidence.outcome, "failed");
  assert.equal(deletion.evidence.outcome, "preserved_local");
});

test("v2 diagnostic creates the same bounded action classes", () => {
  const inspect = proposeActionFromDiagnostic(v2Fixture, {
    actionType: "inspect_run_receipt",
    laneId: "site-refresh",
  });
  const retry = proposeActionFromDiagnostic(v2Fixture, {
    actionType: "retry_failed_lane",
    laneId: "site-refresh",
  });
  const deletion = proposeActionFromDiagnostic(v2Fixture, {
    actionType: "delete_preserved_output",
    laneId: "research-watch",
  });
  assert.equal(inspect.request.evidence.diagnosticFormat, "context-layer-diagnostic/v2");
  assert.equal(retry.evidence.outcome, "failed");
  assert.equal(deletion.evidence.outcome, "preserved_local");
});

test("tampered assessment, missing evidence, stale evidence, and unsupported version fail", () => {
  const tampered = structuredClone(fixture) as any;
  tampered.assessment.laneAssessments.find((lane: any) => lane.id === "site-refresh").outcome = "success";
  assert.throws(
    () => proposeActionFromDiagnostic(tampered, { actionType: "retry_failed_lane", laneId: "site-refresh" }),
    /contradicts/,
  );
  const missing = structuredClone(fixture) as any;
  missing.records = missing.records.filter((record: any) => record.id !== "site-refresh-receipt");
  assert.throws(
    () => proposeActionFromDiagnostic(missing, { actionType: "retry_failed_lane", laneId: "site-refresh" }),
    /absent/,
  );
  const stale = structuredClone(fixture) as any;
  stale.records.find((record: any) => record.id === "site-refresh-receipt").validUntil = "2026-07-28T09:00:00Z";
  assert.throws(
    () => proposeActionFromDiagnostic(stale, { actionType: "retry_failed_lane", laneId: "site-refresh" }),
    /stale/,
  );
  assert.throws(
    () => proposeActionFromDiagnostic({ ...fixture, format: "context-layer-diagnostic/v3" }, { actionType: "retry_failed_lane", laneId: "site-refresh" }),
    /format/,
  );
});

test("v2 rejects assertion, schedule, and source-time tampering", () => {
  assert.throws(
    () =>
      proposeActionFromDiagnostic(
        { ...fixture, format: "context-layer-diagnostic/v2" },
        { actionType: "retry_failed_lane", laneId: "site-refresh" },
      ),
    /must contain exactly one typed operational assertion/,
  );

  const missingAssertion = structuredClone(v2Fixture) as any;
  delete missingAssertion.records.find(
    (record: any) => record.id === "site-refresh-receipt",
  ).claims[0].operational;
  assert.throws(
    () =>
      proposeActionFromDiagnostic(missingAssertion, {
        actionType: "retry_failed_lane",
        laneId: "site-refresh",
      }),
    /must contain exactly one typed operational assertion/,
  );

  const duplicateAssertion = structuredClone(v2Fixture) as any;
  const duplicateRecord = duplicateAssertion.records.find(
    (record: any) => record.id === "site-refresh-receipt",
  );
  duplicateRecord.claims.push({
    ...duplicateRecord.claims[0],
    text: "Duplicate typed assertion.",
  });
  assert.throws(
    () =>
      proposeActionFromDiagnostic(duplicateAssertion, {
        actionType: "retry_failed_lane",
        laneId: "site-refresh",
      }),
    /must contain exactly one typed operational assertion/,
  );

  const assertionMismatch = structuredClone(v2Fixture) as any;
  assertionMismatch.records
    .find((record: any) => record.id === "site-refresh-receipt")
    .claims[0].operational.outcome = "success";
  assert.throws(
    () =>
      proposeActionFromDiagnostic(assertionMismatch, {
        actionType: "retry_failed_lane",
        laneId: "site-refresh",
      }),
    /does not match its typed operational assertion/,
  );

  const scheduleMismatch = structuredClone(v2Fixture) as any;
  scheduleMismatch.scenario.lanes.find(
    (lane: any) => lane.id === "site-refresh",
  ).dueAt = "2026-07-28T10:00:00Z";
  assert.throws(
    () =>
      proposeActionFromDiagnostic(scheduleMismatch, {
        actionType: "retry_failed_lane",
        laneId: "site-refresh",
      }),
    /does not match its typed operational assertion/,
  );

  const sourceTimeMismatch = structuredClone(v2Fixture) as any;
  sourceTimeMismatch.scenario.receipts.find(
    (receipt: any) => receipt.recordId === "site-refresh-receipt",
  ).observedAt = "2026-07-28T08:41:00Z";
  sourceTimeMismatch.records
    .find((record: any) => record.id === "site-refresh-receipt")
    .claims[0].operational.observedAt = "2026-07-28T08:41:00Z";
  assert.throws(
    () =>
      proposeActionFromDiagnostic(sourceTimeMismatch, {
        actionType: "retry_failed_lane",
        laneId: "site-refresh",
      }),
    /not bound to a source at its observation time/,
  );
});

test("consumer rejects actions for lanes outside their due window", () => {
  const notDue = structuredClone(fixture) as any;
  notDue.scenario.lanes.find((lane: any) => lane.id === "site-refresh").dueAt =
    "2026-07-28T10:00:00Z";
  assert.throws(
    () =>
      proposeActionFromDiagnostic(notDue, {
        actionType: "retry_failed_lane",
        laneId: "site-refresh",
      }),
    /not yet due/,
  );
});

test("recheck binds the executable action to the exact diagnostic evidence", () => {
  const proposal = proposeActionFromDiagnostic(fixture, {
    actionType: "retry_failed_lane",
    laneId: "site-refresh",
  });
  if (proposal.request.action.type !== "retry_failed_lane") {
    throw new Error("Expected retry action.");
  }
  const retryAction = proposal.request.action;
  assert.doesNotThrow(() => recheckProposal(fixture, proposal.request));
  assert.throws(
    () =>
      recheckProposal(fixture, {
        ...proposal.request,
        evidence: {
          ...proposal.request.evidence,
          diagnosticHash: "a".repeat(64),
        },
      }),
    /no longer matches/,
  );
  assert.throws(
    () =>
      recheckProposal(fixture, {
        ...proposal.request,
        action: {
          ...retryAction,
          retryPayloadHash: "b".repeat(64),
        },
      }),
    /no longer matches/,
  );
});
