#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { FileApprovalStore } from "./approval.js";
import { SyntheticAutomationAdapter } from "./adapters/synthetic-automation.js";
import type { PolicyManifest } from "./contracts.js";
import { systemClock } from "./policy.js";
import { FileReceiptStore } from "./store.js";
import {
  handleEvaluateAction,
  handleExecuteApprovedAction,
  handleExplainDecision,
  handleSimulateAction,
  handleVerifyReceipt,
  type ToolDependencies,
} from "./tool-handlers.js";

function toolResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    isError,
  };
}

const policy = JSON.parse(await readFile("data/policy.json", "utf8")) as PolicyManifest;
const dependencies: ToolDependencies = {
  policy,
  adapter: new SyntheticAutomationAdapter(resolve(".runtime/mcp-sandbox")),
  approvals: new FileApprovalStore(resolve(".approvals/approvals.json")),
  receipts: new FileReceiptStore(resolve(".receipts/receipts.json")),
  registry: new Map(),
  clock: systemClock,
};
const server = new McpServer({ name: "governed-action-lab", version: "0.2.0" });

server.registerTool(
  "evaluate_action",
  {
    description: "Validate and deterministically evaluate a typed governed action request.",
    inputSchema: { request: z.unknown(), diagnostic: z.unknown() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async (input) => toolResult(handleEvaluateAction(dependencies, input)),
);
server.registerTool(
  "explain_action_decision",
  {
    description: "Return policy rules, evidence IDs, and unmet requirements for a decision.",
    inputSchema: { decision: z.unknown() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async (input) => toolResult(handleExplainDecision(input)),
);
server.registerTool(
  "simulate_action",
  {
    description: "Project bounded effects without executing them.",
    inputSchema: { request: z.unknown() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async (input) => toolResult(await handleSimulateAction(dependencies, input)),
);
server.registerTool(
  "execute_approved_action",
  {
    description: "Execute a previously evaluated action only when a separate exact approval already exists.",
    inputSchema: { actionId: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async (input) => {
    const response = await handleExecuteApprovedAction(dependencies, input);
    return toolResult(response, !response.ok);
  },
);
server.registerTool(
  "verify_action_receipt",
  {
    description: "Verify a receipt's strict schema and canonical digest.",
    inputSchema: { receipt: z.unknown() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async (input) => {
    const response = handleVerifyReceipt(input);
    return toolResult(response, !response.ok);
  },
);

await server.connect(new StdioServerTransport());
