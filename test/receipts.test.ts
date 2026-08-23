import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { digestOmitting } from "../src/canonical.js";
import {
  executionReceiptSchema,
  type ExecutionReceipt,
} from "../src/contracts.js";
import { verifyReceipt } from "../src/receipts.js";

const packet = JSON.parse(
  await readFile("docs/governed-action-proof.json", "utf8"),
);
const first = executionReceiptSchema.parse(packet.receipt);

function withValidDigest(input: ExecutionReceipt): ExecutionReceipt {
  const receipt = { ...input, receiptDigest: "0".repeat(64) };
  receipt.receiptDigest = digestOmitting(receipt, "receiptDigest");
  return executionReceiptSchema.parse(receipt);
}

test("receipt verifier detects content mutation, field deletion, and field insertion", () => {
  assert.equal(verifyReceipt(first).valid, true);
  assert.equal(verifyReceipt({ ...first, result: "failed" }).valid, false);

  const deleted = structuredClone(first) as Partial<ExecutionReceipt>;
  delete deleted.actionId;
  assert.equal(verifyReceipt(deleted).valid, false);

  assert.equal(verifyReceipt({ ...first, unexpected: true }).valid, false);
});

test("EXPECTED LIMITATION: receipt collection deletion, insertion, reordering, and duplication are not detectable", () => {
  const second = withValidDigest({
    ...first,
    id: "receipt-second-valid",
    previousReceiptId: first.id,
  });
  const inserted = withValidDigest({
    ...first,
    id: "receipt-inserted-valid",
    previousReceiptId: second.id,
  });
  const collections = [
    [second],
    [first, inserted, second],
    [second, first],
    [first, second, second],
  ];

  for (const collection of collections) {
    assert.equal(collection.every((receipt) => verifyReceipt(receipt).valid), true);
  }
});
