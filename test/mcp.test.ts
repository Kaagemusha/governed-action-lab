import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemoryApprovalStore } from "../src/approval.js";
import { SyntheticAutomationAdapter } from "../src/adapters/synthetic-automation.js";
import type { PolicyManifest } from "../src/contracts.js";
import { proposeActionFromDiagnostic } from "../src/context-adapter.js";
import { evaluateAction } from "../src/policy.js";
import { MemoryReceiptStore } from "../src/store.js";
import {
  AGENT_TOOL_NAMES,
  handleEvaluateAction,
  handleExecuteApprovedAction,
  type ToolDependencies,
} from "../src/tool-handlers.js";

const fixture = JSON.parse(await readFile("examples/context-layer-diagnostic.json", "utf8"));
const policy = JSON.parse(await readFile("data/policy.json", "utf8")) as PolicyManifest;
const clock = { now: () => new Date("2026-07-28T09:10:00Z") };

async function dependencies(): Promise<ToolDependencies> {
  return {
    policy,
    adapter: new SyntheticAutomationAdapter(await mkdtemp(join(tmpdir(), "governed-mcp-"))),
    approvals: new MemoryApprovalStore(),
    receipts: new MemoryReceiptStore(),
    registry: new Map(),
    verifiedPrincipal: { kind: "agent", id: "public-demo-agent" },
    clock,
  };
}

test("MCP evaluation is identical to core evaluation", async () => {
  const proposal = proposeActionFromDiagnostic(fixture, { actionType: "retry_failed_lane", laneId: "site-refresh" });
  const deps = await dependencies();
  const transport = handleEvaluateAction(deps, { request: proposal.request, diagnostic: fixture }).result;
  const core = evaluateAction(proposal.request, policy, proposal.evidence, clock);
  assert.deepEqual(transport, core);
});

test("agent tool surface has no approval capability", () => {
  assert.equal(AGENT_TOOL_NAMES.map(String).some((name) => name === "approve_action" || name.startsWith("create_approval")), false);
  assert.deepEqual(AGENT_TOOL_NAMES, [
    "evaluate_action",
    "explain_action_decision",
    "simulate_action",
    "execute_approved_action",
    "verify_action_receipt",
  ]);
});

test("execute accepts an action identifier, not an approval payload", async () => {
  const deps = await dependencies();
  const result = await handleExecuteApprovedAction(deps, { actionId: "missing" });
  assert.equal(result.ok, false);
  assert.equal((result.result as { code: string }).code, "ACTION_NOT_REGISTERED");
});

test("MCP cannot reach the mutating adapter without a separate approval", async () => {
  const deps = await dependencies();
  const proposal = proposeActionFromDiagnostic(fixture, {
    actionType: "retry_failed_lane",
    laneId: "site-refresh",
  });
  handleEvaluateAction(deps, {
    request: proposal.request,
    diagnostic: fixture,
  });

  const response = await handleExecuteApprovedAction(deps, {
    actionId: proposal.request.id,
  });
  const receipt = response.result as {
    result: string;
    effects: unknown[];
  };

  assert.equal(response.ok, false);
  assert.equal(receipt.result, "refused");
  assert.equal(receipt.effects.length, 0);
  assert.equal((deps.adapter as SyntheticAutomationAdapter).executeCalls, 0);
});

test("MCP execution reports an idempotency conflict without running another action", async () => {
  const deps = await dependencies();
  const first = proposeActionFromDiagnostic(fixture, {
    actionType: "inspect_run_receipt",
    laneId: "site-refresh",
    idempotencyKey: "shared-caller-key",
  });
  handleEvaluateAction(deps, { request: first.request, diagnostic: fixture });
  const executed = await handleExecuteApprovedAction(deps, { actionId: first.request.id });
  assert.equal(executed.ok, true);

  const collision = proposeActionFromDiagnostic(fixture, {
    actionType: "retry_failed_lane",
    laneId: "site-refresh",
    idempotencyKey: "shared-caller-key",
  });
  handleEvaluateAction(deps, { request: collision.request, diagnostic: fixture });
  const refused = await handleExecuteApprovedAction(deps, { actionId: collision.request.id });
  assert.equal(refused.ok, false);
  assert.equal((refused.result as { code: string }).code, "IDEMPOTENCY_CONFLICT");
  assert.equal((deps.adapter as SyntheticAutomationAdapter).executeCalls, 0);
  assert.equal((await deps.receipts.list()).length, 1);
});
