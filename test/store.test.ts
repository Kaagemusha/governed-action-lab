import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileReceiptStore,
  MemoryReceiptStore,
  type ReceiptStore,
} from "../src/store.js";

const firstDigest = "a".repeat(64);
const secondDigest = "b".repeat(64);

async function stores(kind: "memory" | "file"): Promise<[ReceiptStore, ReceiptStore]> {
  if (kind === "memory") {
    const store = new MemoryReceiptStore();
    return [store, store];
  }
  const path = join(
    await mkdtemp(join(tmpdir(), "governed-store-claim-")),
    "receipts.json",
  );
  return [new FileReceiptStore(path), new FileReceiptStore(path)];
}

for (const kind of ["memory", "file"] as const) {
  test(`${kind} store atomically rejects concurrent cross-action claims`, async () => {
    const [left, right] = await stores(kind);
    const claims = await Promise.all([
      left.claim("shared-key", firstDigest),
      right.claim("shared-key", secondDigest),
    ]);
    assert.deepEqual(
      claims.map((claim) => claim.status).sort(),
      ["claimed", "conflict"],
    );
    await left.release("shared-key", firstDigest);
    await right.release("shared-key", secondDigest);
  });

  test(`${kind} store permits only one concurrent same-action claim`, async () => {
    const [left, right] = await stores(kind);
    const claims = await Promise.all([
      left.claim("shared-key", firstDigest),
      right.claim("shared-key", firstDigest),
    ]);
    assert.deepEqual(
      claims.map((claim) => claim.status).sort(),
      ["claimed", "in_progress"],
    );
    await left.release("shared-key", firstDigest);
    await right.release("shared-key", firstDigest);
  });
}
