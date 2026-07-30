import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { executionReceiptSchema, type ExecutionReceipt } from "./contracts.js";

export interface ReceiptStore {
  append(receipt: ExecutionReceipt, idempotencyKey: string): Promise<void>;
  findSuccessful(idempotencyKey: string): Promise<ExecutionReceipt | null>;
  list(): Promise<ExecutionReceipt[]>;
}

export class MemoryReceiptStore implements ReceiptStore {
  readonly receipts: ExecutionReceipt[] = [];
  readonly idempotency = new Map<string, string>();

  async append(receipt: ExecutionReceipt, idempotencyKey: string): Promise<void> {
    this.receipts.push(structuredClone(receipt));
    if (receipt.result === "succeeded" || receipt.result === "compensated") {
      this.idempotency.set(idempotencyKey, receipt.id);
    }
  }

  async findSuccessful(idempotencyKey: string): Promise<ExecutionReceipt | null> {
    const id = this.idempotency.get(idempotencyKey);
    return this.receipts.find((receipt) => receipt.id === id) ?? null;
  }

  async list(): Promise<ExecutionReceipt[]> {
    return structuredClone(this.receipts);
  }
}

type StoreData = {
  receipts: ExecutionReceipt[];
  idempotency: Record<string, string>;
};

export class FileReceiptStore implements ReceiptStore {
  constructor(readonly path: string) {}

  private async read(): Promise<StoreData> {
    const parsed = JSON.parse(
      await readFile(this.path, "utf8").catch(() => '{"receipts":[],"idempotency":{}}'),
    ) as StoreData;
    return {
      receipts: parsed.receipts.map((receipt) => executionReceiptSchema.parse(receipt)),
      idempotency: parsed.idempotency,
    };
  }

  private async write(value: StoreData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  }

  async append(receipt: ExecutionReceipt, idempotencyKey: string): Promise<void> {
    const data = await this.read();
    data.receipts.push(receipt);
    if (receipt.result === "succeeded" || receipt.result === "compensated") {
      data.idempotency[idempotencyKey] = receipt.id;
    }
    await this.write(data);
  }

  async findSuccessful(idempotencyKey: string): Promise<ExecutionReceipt | null> {
    const data = await this.read();
    const id = data.idempotency[idempotencyKey];
    return data.receipts.find((receipt) => receipt.id === id) ?? null;
  }

  async list(): Promise<ExecutionReceipt[]> {
    return (await this.read()).receipts;
  }
}
