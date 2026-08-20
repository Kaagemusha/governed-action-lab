import { digestOmitting } from "./canonical.js";
import {
  RECEIPT_VERSION,
  executionReceiptSchema,
  type ActionRequest,
  type ExecutionReceipt,
  type PolicyDecision,
} from "./contracts.js";
import type { ActionAdapter, AdapterEffect } from "./adapters/synthetic-automation.js";

export function createReceipt(input: {
  request: ActionRequest;
  decision: PolicyDecision;
  approvalId: string | null;
  adapter: Pick<ActionAdapter, "id" | "version">;
  startedAt: string;
  endedAt: string;
  result: ExecutionReceipt["result"];
  precondition: { passed: boolean; detail: string };
  effects?: AdapterEffect[];
  verification?: { passed: boolean; detail: string };
  compensation?: ExecutionReceipt["compensation"];
  previousReceiptId?: string | null;
}): ExecutionReceipt {
  const partial = {
    schemaVersion: RECEIPT_VERSION,
    id: `receipt-${globalThis.crypto.randomUUID()}`,
    requestId: input.request.id,
    actionDigest: input.decision.actionDigest,
    decisionDigest: input.decision.decisionDigest,
    approvalId: input.approvalId,
    adapter: { id: input.adapter.id, version: input.adapter.version },
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    result: input.result,
    preconditionCheck: input.precondition,
    effects: input.effects ?? [],
    verification: input.verification ?? { passed: false, detail: "Execution did not reach verification." },
    compensation: input.compensation ?? {
      supported: false,
      authorized: false,
      attempted: false,
      result: "not_needed",
    },
    previousReceiptId: input.previousReceiptId ?? null,
    receiptDigest: "0".repeat(64),
  } satisfies ExecutionReceipt;
  partial.receiptDigest = digestOmitting(partial, "receiptDigest");
  return executionReceiptSchema.parse(partial);
}

export function verifyReceipt(input: unknown): { valid: boolean; detail: string } {
  const parsed = executionReceiptSchema.safeParse(input);
  if (!parsed.success) return { valid: false, detail: parsed.error.issues[0]?.message ?? "Invalid receipt." };
  return digestOmitting(parsed.data, "receiptDigest") === parsed.data.receiptDigest
    ? { valid: true, detail: "Receipt schema and digest verify." }
    : { valid: false, detail: "Receipt digest does not match its contents." };
}
