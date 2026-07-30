import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256 } from "../canonical.js";
import type { ActionRequest } from "../contracts.js";

export type AdapterEffect = {
  kind: string;
  resourceId: string;
  beforeHash: string;
  afterHash: string;
};

export type AdapterExecution = {
  effects: AdapterEffect[];
  snapshot: string | null;
  detail: string;
};

export interface ActionAdapter {
  id: string;
  version: string;
  inspect(request: ActionRequest): Promise<AdapterExecution>;
  plan(request: ActionRequest): Promise<{ effect: string; reversible: boolean }>;
  execute(request: ActionRequest): Promise<AdapterExecution>;
  verify(request: ActionRequest, execution: AdapterExecution): Promise<{ passed: boolean; detail: string }>;
  compensate(request: ActionRequest, execution: AdapterExecution): Promise<{ passed: boolean; detail: string }>;
}

export class SyntheticAutomationAdapter implements ActionAdapter {
  readonly id = "synthetic-automation";
  readonly version = "1.0.0";
  readonly retryPath: string;
  executeCalls = 0;

  constructor(readonly sandboxDirectory: string) {
    this.retryPath = join(sandboxDirectory, "retry-record.json");
  }

  async inspect(request: ActionRequest): Promise<AdapterExecution> {
    const beforeHash = request.expectedState.contentHash ?? sha256(request.expectedState);
    return {
      effects: [{ kind: "read", resourceId: request.target.resourceId, beforeHash, afterHash: beforeHash }],
      snapshot: null,
      detail: `Read bounded receipt ${request.action.recordId}.`,
    };
  }

  async plan(request: ActionRequest): Promise<{ effect: string; reversible: boolean }> {
    return {
      effect:
        request.action.type === "retry_failed_lane"
          ? `Create one retry record for ${request.action.laneId}.`
          : `Read receipt ${request.action.recordId}.`,
      reversible: request.action.type === "retry_failed_lane",
    };
  }

  async execute(request: ActionRequest): Promise<AdapterExecution> {
    if (request.action.type !== "retry_failed_lane") {
      throw new Error("Synthetic executor accepts only retry_failed_lane mutations.");
    }
    this.executeCalls += 1;
    if (request.action.simulateFailure === "before_effect") {
      throw new Error("Simulated failure before effect.");
    }
    await mkdir(this.sandboxDirectory, { recursive: true });
    const before = await readFile(this.retryPath, "utf8").catch(() => "");
    const content = `${JSON.stringify({
      laneId: request.action.laneId,
      evidenceRecordId: request.action.recordId,
      payloadHash: request.action.retryPayloadHash,
    }, null, 2)}\n`;
    await writeFile(this.retryPath, content);
    const execution: AdapterExecution = {
      effects: [{
        kind: "create_retry_record",
        resourceId: request.target.resourceId,
        beforeHash: sha256(before),
        afterHash: sha256(content),
      }],
      snapshot: before,
      detail: "Synthetic retry record created.",
    };
    if (request.action.simulateFailure === "after_effect") {
      const error = new Error("Simulated failure after partial effect.") as Error & { execution?: AdapterExecution };
      error.execution = execution;
      throw error;
    }
    return execution;
  }

  async verify(request: ActionRequest, execution: AdapterExecution): Promise<{ passed: boolean; detail: string }> {
    if (request.action.type === "inspect_run_receipt") {
      return { passed: execution.effects.every((effect) => effect.beforeHash === effect.afterHash), detail: "Read effect did not mutate state." };
    }
    const content = await readFile(this.retryPath, "utf8").catch(() => "");
    const effect = execution.effects[0];
    const passed =
      request.action.type === "retry_failed_lane" &&
      content.includes(`"laneId": "${request.action.laneId}"`) &&
      content.includes(`"evidenceRecordId": "${request.action.recordId}"`) &&
      effect?.afterHash === sha256(content);
    return { passed, detail: passed ? "Retry record matches lane, evidence, and content hash." : "Retry record verification failed." };
  }

  async compensate(_request: ActionRequest, execution: AdapterExecution): Promise<{ passed: boolean; detail: string }> {
    if (execution.snapshot === null) return { passed: false, detail: "No pre-action snapshot exists." };
    await writeFile(this.retryPath, execution.snapshot);
    const restored = await readFile(this.retryPath, "utf8");
    return { passed: restored === execution.snapshot, detail: "Exact pre-action sandbox snapshot restored." };
  }
}
