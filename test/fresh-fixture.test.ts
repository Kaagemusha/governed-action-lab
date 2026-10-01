import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { freshenPublicFixture } from "../src/fresh-fixture.js";

test("fresh public fixture preserves relative times while moving asOf", async () => {
  const fixture = JSON.parse(
    await readFile("examples/context-layer-diagnostic-v2.json", "utf8"),
  );
  const sourceAsOf = new Date(fixture.scenario.asOf).getTime();
  const sourceReceipt = new Date(fixture.scenario.receipts[1].observedAt).getTime();
  const target = new Date("2026-07-31T15:00:00Z");

  const fresh = freshenPublicFixture(fixture, target);

  assert.equal(fresh.scenario.asOf, "2026-07-31T15:00:00.000Z");
  assert.equal(
    new Date(fresh.scenario.receipts[1]!.observedAt).getTime() - target.getTime(),
    sourceReceipt - sourceAsOf,
  );
  assert.equal(fresh.assessment.asOf, fresh.scenario.asOf);
  assert.equal(fresh.format, "context-layer-diagnostic/v2");
  assert.equal(
    fresh.records[0]?.claims[0]?.operational?.observedAt,
    fresh.scenario.summary.observedAt,
  );
});

test("fresh public fixture rejects an invalid target time", async () => {
  const fixture = JSON.parse(await readFile("examples/context-layer-diagnostic.json", "utf8"));
  assert.throws(() => freshenPublicFixture(fixture, new Date("invalid")), /valid instant/);
});

test("fixture freshening retains v1 compatibility", async () => {
  const fixture = JSON.parse(await readFile("examples/context-layer-diagnostic.json", "utf8"));
  const fresh = freshenPublicFixture(fixture, new Date("2026-07-31T15:00:00Z"));
  assert.equal(fresh.format, "context-layer-diagnostic/v1");
});
