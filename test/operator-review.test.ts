import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SyntheticAutomationAdapter } from "../src/adapters/synthetic-automation.js";
import { digestOmitting, sha256 } from "../src/canonical.js";
import type { PolicyManifest } from "../src/contracts.js";
import {
  prepareActionReview,
  renderActionReviewBrief,
  verifyActionReview,
} from "../src/operator-review.js";
import { actionDigest } from "../src/policy.js";

const diagnostic = JSON.parse(
  await readFile("examples/context-layer-diagnostic.json", "utf8"),
);
const diagnosticV2 = JSON.parse(
  await readFile("examples/context-layer-diagnostic-v2.json", "utf8"),
);
const policy = JSON.parse(
  await readFile("data/policy.json", "utf8"),
) as PolicyManifest;
const adapter = new SyntheticAutomationAdapter(".runtime/operator-review-test");
const clock = { now: () => new Date("2026-07-28T09:10:00Z") };

test("prepares ready, approval-required, and refused reviews without execution", async () => {
  const ready = await prepareActionReview(
    diagnostic,
    { actionType: "inspect_run_receipt", laneId: "site-refresh" },
    policy,
    adapter,
    clock,
  );
  const approval = await prepareActionReview(
    diagnostic,
    { actionType: "retry_failed_lane", laneId: "site-refresh" },
    policy,
    adapter,
    clock,
  );
  const refused = await prepareActionReview(
    diagnostic,
    { actionType: "delete_preserved_output", laneId: "research-watch" },
    policy,
    adapter,
    clock,
  );

  assert.deepEqual(
    [ready.status, approval.status, refused.status],
    ["READY", "APPROVAL_REQUIRED", "REFUSED"],
  );
  assert.equal(adapter.executeCalls, 0);
  assert.equal(verifyActionReview(approval).id, approval.id);
});

test("v2 evidence remains explicit in the operator review", async () => {
  const review = await prepareActionReview(
    diagnosticV2,
    { actionType: "retry_failed_lane", laneId: "site-refresh" },
    policy,
    adapter,
    clock,
  );
  assert.equal(review.schemaVersion, "governed-action-review/v2");
  assert.equal(review.diagnostic.format, "context-layer-diagnostic/v2");
  assert.equal(review.request.evidence.diagnosticFormat, review.diagnostic.format);
  assert.equal(verifyActionReview(review).status, "APPROVAL_REQUIRED");
});

test("review verification rejects a format mismatch after digest recomputation", async () => {
  const review = await prepareActionReview(
    diagnosticV2,
    { actionType: "retry_failed_lane", laneId: "site-refresh" },
    policy,
    adapter,
    clock,
  );
  const forged = structuredClone(review) as any;
  forged.request.evidence.diagnosticFormat = "context-layer-diagnostic/v1";
  forged.decision.actionDigest = actionDigest(forged.request);
  forged.decision.decisionDigest = digestOmitting(
    forged.decision,
    "decisionDigest",
  );
  forged.id = `review-${sha256({
    request: forged.request,
    decision: forged.decision,
  }).slice(0, 16)}`;
  forged.reviewDigest = digestOmitting(forged, "reviewDigest");

  assert.throws(
    () => verifyActionReview(forged),
    /diagnostic format does not match/,
  );
});

test("renders a bounded operator brief", async () => {
  const review = await prepareActionReview(
    diagnostic,
    { actionType: "retry_failed_lane", laneId: "site-refresh" },
    policy,
    adapter,
    clock,
  );
  const brief = renderActionReviewBrief(review);

  assert.match(brief, /Status: APPROVAL_REQUIRED/);
  assert.match(brief, /agent cannot approve/);
  assert.match(brief, /retry_failed_lane on site-refresh/);
  assert.equal(brief.trim().split("\n").length, 6);
});

test("rejects a tampered review packet", async () => {
  const review = await prepareActionReview(
    diagnostic,
    { actionType: "retry_failed_lane", laneId: "site-refresh" },
    policy,
    adapter,
    clock,
  );

  assert.throws(
    () => verifyActionReview({ ...review, status: "READY" }),
    /status does not match/,
  );
  assert.throws(
    () => verifyActionReview({ ...review, reviewDigest: "a".repeat(64) }),
    /digest verification failed/,
  );
  assert.throws(
    () =>
      verifyActionReview({
        ...review,
        decision: { ...review.decision, reasonCodes: ["FORGED"] },
      }),
    /decision digest verification failed/,
  );
});
