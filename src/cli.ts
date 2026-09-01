#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { FileApprovalStore, OperatorApprovalProvider } from "./approval.js";
import { SyntheticAutomationAdapter } from "./adapters/synthetic-automation.js";
import {
  catalogActionTypeSchema,
  actionRequestSchema,
  executionReceiptSchema,
  policyDecisionSchema,
  type CatalogAction,
  type PolicyManifest,
} from "./contracts.js";
import { proposeActionFromDiagnostic, recheckProposal } from "./context-adapter.js";
import { executeGovernedAction, IdempotencyStateError } from "./executor.js";
import { evaluateAction, systemClock } from "./policy.js";
import { prepareActionReview, renderActionReviewBrief } from "./operator-review.js";
import { verifyPortableProof } from "./proof-packet.js";
import { verifyReceipt } from "./receipts.js";
import { FileReceiptStore } from "./store.js";

const CLI_VERIFIED_PRINCIPAL = {
  kind: "agent",
  id: "public-demo-agent",
} as const;

type Args = Record<string, string | boolean>;
function parseArgs(values: string[]): Args {
  const result: Args = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else result[key] = true;
  }
  return result;
}
function required(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`--${key} is required.`);
  return value;
}
async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}
async function output(value: unknown, args: Args): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (typeof args.output === "string") await writeFile(args.output, serialized);
  process.stdout.write(serialized);
}
async function loadPolicy(args: Args): Promise<PolicyManifest> {
  return (await json(typeof args.policy === "string" ? args.policy : "data/policy.json")) as PolicyManifest;
}
function actionType(args: Args): CatalogAction["type"] {
  return catalogActionTypeSchema.parse(required(args, "action"));
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  if (command === "propose") {
    const proposal = proposeActionFromDiagnostic(await json(required(args, "diagnostic")), {
      actionType: actionType(args),
      laneId: required(args, "lane"),
      ...(typeof args.at === "string" ? { proposedAt: args.at } : {}),
    });
    await output(proposal.request, args);
    return 0;
  }
  if (command === "prepare") {
    const adapter = new SyntheticAutomationAdapter(
      resolve(typeof args.sandbox === "string" ? args.sandbox : ".runtime/preview"),
    );
    const review = await prepareActionReview(
      await json(required(args, "diagnostic")),
      actionRequestSchema.parse(await json(required(args, "request"))),
      await loadPolicy(args),
      adapter,
      typeof args.at === "string" ? { now: () => new Date(args.at as string) } : undefined,
    );
    if (typeof args["brief-output"] === "string") {
      await writeFile(args["brief-output"], renderActionReviewBrief(review));
    }
    await output(review, args);
    return 0;
  }
  if (command === "evaluate") {
    const request = actionRequestSchema.parse(await json(required(args, "request")));
    const adapted = recheckProposal(await json(required(args, "diagnostic")), request);
    const decision = evaluateAction(request, await loadPolicy(args), adapted.evidence, {
      now: () => new Date(typeof args.at === "string" ? args.at : request.proposedAt),
    });
    await output(decision, args);
    return decision.disposition === "refuse" ? 2 : 0;
  }
  if (command === "simulate") {
    const request = actionRequestSchema.parse(await json(required(args, "request")));
    const adapter = new SyntheticAutomationAdapter(resolve(typeof args.sandbox === "string" ? args.sandbox : ".runtime/sandbox"));
    await output(await adapter.plan(request), args);
    return 0;
  }
  if (command === "approve") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("approve requires an interactive terminal.");
    const request = actionRequestSchema.parse(await json(required(args, "request")));
    const decision = policyDecisionSchema.parse(await json(required(args, "decision")));
    const plan = await new SyntheticAutomationAdapter(".runtime/preview").plan(request);
    process.stdout.write(
      `Target: ${request.target.resourceId}\nEffect: ${plan.effect}\nEvidence: ${request.evidence.recordIds.join(", ")}\nExpiry: 5 minutes\nRollback: exact pre-action sandbox snapshot\nAgent cannot approve this action.\n`,
    );
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    const confirmation = await terminal.question('Type "APPROVE" to issue the exact single-use grant: ');
    terminal.close();
    if (confirmation !== "APPROVE") return 2;
    const store = new FileApprovalStore(required(args, "approval-store"));
    const policy = await loadPolicy(args);
    const rule = policy.rules.find(
      (candidate) => candidate.actionType === request.action.type,
    );
    const lifetimeSeconds = rule?.maxApprovalLifetimeSeconds ?? 300;
    const grant = await new OperatorApprovalProvider(store).issue(
      request,
      decision,
      required(args, "operator"),
      true,
      lifetimeSeconds,
    );
    await output(grant, args);
    return 0;
  }
  if (command === "execute") {
    if ("approve" in args || "yes" in args) throw new Error("execute never accepts inline approval.");
    const request = actionRequestSchema.parse(await json(required(args, "request")));
    const decision = policyDecisionSchema.parse(await json(required(args, "decision")));
    const diagnostic = await json(required(args, "diagnostic"));
    const adapted = recheckProposal(diagnostic, request);
    const policy = await loadPolicy(args);
    let receipt: Awaited<ReturnType<typeof executeGovernedAction>>;
    try {
      receipt = await executeGovernedAction(request, decision, {
        policy,
        evidence: adapted.evidence,
        loadCurrentState: async () => ({
          evidence: adapted.evidence,
          currentTargetHash: adapted.targetHash,
          diagnosticAsOf: adapted.diagnostic.scenario.asOf,
        }),
        adapter: new SyntheticAutomationAdapter(resolve(required(args, "sandbox"))),
        approvals: new FileApprovalStore(required(args, "approval-store")),
        receipts: new FileReceiptStore(required(args, "receipt-store")),
        verifiedPrincipal: CLI_VERIFIED_PRINCIPAL,
        clock: systemClock,
      });
    } catch (error) {
      if (error instanceof IdempotencyStateError) {
        await output({ code: error.code, message: error.message }, args);
        return 2;
      }
      throw error;
    }
    await output(receipt, args);
    return receipt.result === "succeeded" || receipt.result === "compensated" ? 0 : 2;
  }
  if (command === "verify-receipt") {
    const receipt = executionReceiptSchema.parse(await json(required(args, "receipt")));
    const result = verifyReceipt(receipt);
    await output(result, args);
    return result.valid ? 0 : 2;
  }
  if (command === "verify-proof") {
    const proof = await verifyPortableProof(await json(required(args, "proof")));
    await output(
      {
        valid: true,
        schemaVersion: proof.schemaVersion,
        mode: proof.mode,
        packetDigest: proof.packetDigest,
      },
      args,
    );
    return 0;
  }
  if (command === "rollback-request") {
    await output({
      executable: false,
      reason: "V1 supports pre-authorized failure compensation only. A later discretionary rollback requires a separately reviewed catalog action.",
    }, args);
    return 2;
  }
  if (command === "demo") {
    const diagnostic = await json(typeof args.diagnostic === "string" ? args.diagnostic : "examples/context-layer-diagnostic.json");
    const policy = await loadPolicy(args);
    const paths = [
      ["inspect_run_receipt", "site-refresh"],
      ["retry_failed_lane", "site-refresh"],
      ["delete_preserved_output", "research-watch"],
    ] as const;
    const results = paths.map(([actionType, laneId]) => {
      const proposal = proposeActionFromDiagnostic(diagnostic, { actionType, laneId });
      return {
        actionType,
        request: proposal.request,
        decision: evaluateAction(proposal.request, policy, proposal.evidence, {
          now: () => new Date(proposal.request.proposedAt),
        }),
      };
    });
    await output(results, args);
    return 0;
  }
  throw new Error("Command must be prepare, propose, evaluate, simulate, approve, execute, verify-receipt, verify-proof, rollback-request, or demo.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
      process.exitCode = 1;
    },
  );
}
