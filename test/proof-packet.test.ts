import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { digestOmitting } from "../src/canonical.js";
import type { ProofPacket } from "../src/contracts.js";
import { buildPortableGreenProof, verifyPortableProof } from "../src/proof-packet.js";

const committed = JSON.parse(await readFile("docs/governed-action-proof.json", "utf8")) as ProofPacket;
const diagnostic = JSON.parse(await readFile("examples/context-layer-diagnostic-v2.json", "utf8"));
const metadata = JSON.parse(await readFile("examples/fixture-metadata-v2.json", "utf8"));
const policy = JSON.parse(await readFile("data/policy.json", "utf8"));

function copy(): ProofPacket {
  return structuredClone(committed);
}

function resignPacket(packet: ProofPacket): void {
  packet.packetDigest = digestOmitting(packet, "packetDigest");
}

function resignReview(packet: ProofPacket): void {
  packet.review.reviewDigest = digestOmitting(packet.review, "reviewDigest");
  resignPacket(packet);
}

function resignReceipt(packet: ProofPacket): void {
  packet.receipt.receiptDigest = digestOmitting(packet.receipt, "receiptDigest");
  resignPacket(packet);
}

test("committed portable green packet verifies and regenerates exactly", async () => {
  assert.deepEqual(await verifyPortableProof(committed), committed);
  assert.deepEqual(await buildPortableGreenProof({ diagnostic, metadata, policy }), committed);
});

test("proof schema rejects unknown top-level and nested keys", async () => {
  await assert.rejects(verifyPortableProof({ ...copy(), unexpected: true }));
  const nested = copy() as ProofPacket & { diagnosticSource: ProofPacket["diagnosticSource"] & { unexpected?: boolean } };
  nested.diagnosticSource.unexpected = true;
  await assert.rejects(verifyPortableProof(nested));
});

test("proof rejects changed frozen diagnostic provenance", async () => {
  const source = copy();
  source.diagnosticSource.producerArtifact = "docs/other.json";
  resignPacket(source);
  await assert.rejects(verifyPortableProof(source), /provenance/);

  const fixture = copy();
  fixture.diagnosticSource.fixtureSha256 = "a".repeat(64);
  resignPacket(fixture);
  await assert.rejects(verifyPortableProof(fixture), /provenance/);
});

test("proof rejects changed diagnostic and trusted policy even when re-digested", async () => {
  const changedDiagnostic = copy();
  changedDiagnostic.diagnostic.scenario.question = "A different question";
  resignPacket(changedDiagnostic);
  await assert.rejects(verifyPortableProof(changedDiagnostic), /diagnostic canonical digest/);

  const changedPolicy = copy();
  changedPolicy.policy.maxEvidenceAgeSeconds += 1;
  resignPacket(changedPolicy);
  await assert.rejects(verifyPortableProof(changedPolicy), /trusted public policy/);
});

test("proof rejects a changed review plan even with valid nested and outer digests", async () => {
  const packet = copy();
  packet.review.plan.effect = "Read an unbounded resource.";
  resignReview(packet);
  await assert.rejects(verifyPortableProof(packet), /deterministic policy evaluation and plan/);
});

test("proof rejects approval authority and non-null receipt approval", async () => {
  const boundary = structuredClone(committed) as unknown as Record<string, unknown>;
  boundary.approvalBoundary = { required: true, grant: { id: "grant" } };
  await assert.rejects(verifyPortableProof(boundary));

  const packet = copy();
  packet.receipt.approvalId = "approval-forbidden";
  resignReceipt(packet);
  await assert.rejects(verifyPortableProof(packet), /must not carry an approval/);
});

test("proof rejects receipt semantic tampering even when receipt and packet digests are repaired", async () => {
  const packet = copy();
  packet.receipt.effects[0]!.beforeHash = "d".repeat(64);
  packet.receipt.effects[0]!.afterHash = "d".repeat(64);
  resignReceipt(packet);
  await assert.rejects(verifyPortableProof(packet), /expected content hash/);

  const time = copy();
  time.receipt.endedAt = "2026-07-28T09:10:01.000Z";
  resignReceipt(time);
  await assert.rejects(verifyPortableProof(time), /times are not coherent and frozen/);
});

test("proof rejects invalid nested and outer digests", async () => {
  const review = copy();
  review.review.reviewDigest = "a".repeat(64);
  resignPacket(review);
  await assert.rejects(verifyPortableProof(review), /Review digest/);

  const receipt = copy();
  receipt.receipt.receiptDigest = "a".repeat(64);
  resignPacket(receipt);
  await assert.rejects(verifyPortableProof(receipt), /receipt schema or digest/);

  const outer = copy();
  outer.packetDigest = "a".repeat(64);
  await assert.rejects(verifyPortableProof(outer), /outer packet digest/);
});

test("portable receipt remains strictly green, synthetic, read-only, and approval-free", () => {
  assert.equal(committed.synthetic, true);
  assert.equal(committed.mode, "synthetic_green_inspection");
  assert.equal(committed.review.decision.classification, "green");
  assert.equal(committed.review.request.target.environment, "read_only");
  assert.equal(committed.approvalBoundary.grant, null);
  assert.equal(committed.receipt.approvalId, null);
  assert.deepEqual(committed.receipt.effects.map((effect) => effect.kind), ["read"]);
});
