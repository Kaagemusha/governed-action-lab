import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  proposeActionFromDiagnostic,
  recheckProposal,
} from "../src/context-adapter.js";

const fixture = JSON.parse(await readFile("examples/context-layer-diagnostic.json", "utf8")) as Record<string, unknown>;

test("diagnostic creates exact green, yellow, and red requests", () => {
  const inspect = proposeActionFromDiagnostic(fixture, { actionType: "inspect_run_receipt", laneId: "site-refresh" });
  const retry = proposeActionFromDiagnostic(fixture, { actionType: "retry_failed_lane", laneId: "site-refresh" });
  const deletion = proposeActionFromDiagnostic(fixture, { actionType: "delete_preserved_output", laneId: "research-watch" });
  assert.equal(inspect.request.target.environment, "read_only");
  assert.equal(inspect.request.intent, "Inspect the latest run receipt.");
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
    () => proposeActionFromDiagnostic({ ...fixture, format: "context-layer-diagnostic/v2" }, { actionType: "retry_failed_lane", laneId: "site-refresh" }),
    /format/,
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
