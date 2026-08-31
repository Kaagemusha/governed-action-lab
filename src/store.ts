import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { executionReceiptSchema, type ApprovalGrant, type ExecutionReceipt } from "./contracts.js";

export type IdempotencyClaim =
  | { status: "claimed"; claimId: string }
  | { status: "replay"; receipt: ExecutionReceipt }
  | { status: "conflict" }
  | { status: "in_progress" }
  | { status: "orphaned"; claimId: string; checkpoint: ClaimCheckpoint | null };

export type ClaimCheckpoint = {
  actionId: string;
  startedAt: string;
  approval: ApprovalGrant;
  adapterState: { before: string; intended: string };
};

type ActiveClaim = {
  schemaVersion: "governed-action-claim/v1";
  actionDigest: string;
  claimId: string;
  ownerPid: number;
  claimedAt: string;
  checkpoint: ClaimCheckpoint | null;
};

export interface ReceiptStore {
  claim(idempotencyKey: string, actionDigest: string): Promise<IdempotencyClaim>;
  checkpoint(idempotencyKey: string, actionDigest: string, claimId: string, checkpoint: ClaimCheckpoint): Promise<void>;
  recoverOrphaned(idempotencyKey: string, actionDigest: string, claimId: string): Promise<{ claimId: string; checkpoint: ClaimCheckpoint | null } | null>;
  append(receipt: ExecutionReceipt, idempotencyKey: string): Promise<void>;
  release(idempotencyKey: string, actionDigest: string): Promise<void>;
  list(): Promise<ExecutionReceipt[]>;
}

function replayable(receipt: ExecutionReceipt): boolean {
  return (
    receipt.result === "succeeded" ||
    receipt.result === "compensated" ||
    receipt.effects.length > 0
  );
}

export class MemoryReceiptStore implements ReceiptStore {
  readonly receipts: ExecutionReceipt[] = [];
  readonly idempotency = new Map<string, string>();
  readonly bindings = new Map<string, string>();
  readonly active = new Map<string, ActiveClaim>();

  async claim(idempotencyKey: string, actionDigest: string): Promise<IdempotencyClaim> {
    const boundDigest = this.bindings.get(idempotencyKey);
    if (boundDigest && boundDigest !== actionDigest) return { status: "conflict" };
    if (this.active.has(idempotencyKey)) return { status: "in_progress" };

    this.bindings.set(idempotencyKey, actionDigest);
    const active = newActiveClaim(actionDigest);
    this.active.set(idempotencyKey, active);
    const receiptId = this.idempotency.get(idempotencyKey);
    const receipt = this.receipts.find((candidate) => candidate.id === receiptId);
    if (receipt) {
      this.active.delete(idempotencyKey);
      return { status: "replay", receipt: structuredClone(receipt) };
    }
    return { status: "claimed", claimId: active.claimId };
  }

  async checkpoint(idempotencyKey: string, actionDigest: string, claimId: string, checkpoint: ClaimCheckpoint): Promise<void> {
    const active = this.active.get(idempotencyKey);
    if (!active || active.actionDigest !== actionDigest || active.claimId !== claimId) {
      throw new Error("Active idempotency claim changed before checkpoint.");
    }
    this.active.set(idempotencyKey, { ...active, checkpoint: structuredClone(checkpoint) });
  }

  async recoverOrphaned(): Promise<null> {
    return null;
  }

  async append(receipt: ExecutionReceipt, idempotencyKey: string): Promise<void> {
    if (this.bindings.get(idempotencyKey) !== receipt.actionDigest) {
      throw new Error("Receipt action digest does not match its idempotency binding.");
    }
    this.receipts.push(structuredClone(receipt));
    if (replayable(receipt)) this.idempotency.set(idempotencyKey, receipt.id);
    this.active.delete(idempotencyKey);
  }

  async release(idempotencyKey: string, actionDigest: string): Promise<void> {
    if (this.bindings.get(idempotencyKey) === actionDigest) {
      this.active.delete(idempotencyKey);
    }
  }

  async list(): Promise<ExecutionReceipt[]> {
    return structuredClone(this.receipts);
  }
}

type StoreData = {
  receipts: ExecutionReceipt[];
  idempotency: Record<string, string>;
};

type FileBinding = {
  idempotencyKey: string;
  actionDigest: string;
};

function newActiveClaim(actionDigest: string, checkpoint: ClaimCheckpoint | null = null): ActiveClaim {
  return {
    schemaVersion: "governed-action-claim/v1",
    actionDigest,
    claimId: randomUUID(),
    ownerPid: process.pid,
    claimedAt: new Date().toISOString(),
    checkpoint,
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

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
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(this.path), `.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  private token(idempotencyKey: string): string {
    return createHash("sha256").update(idempotencyKey).digest("hex");
  }

  private bindingDirectory(): string {
    return `${this.path}.idempotency`;
  }

  private bindingPath(idempotencyKey: string): string {
    return join(this.bindingDirectory(), `${this.token(idempotencyKey)}.json`);
  }

  private activePath(idempotencyKey: string): string {
    return join(this.bindingDirectory(), `${this.token(idempotencyKey)}.active`);
  }

  private recoveryPath(idempotencyKey: string): string {
    return join(this.bindingDirectory(), `${this.token(idempotencyKey)}.recovering`);
  }

  private async readActive(path: string): Promise<ActiveClaim | null> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ActiveClaim>;
      if (
        parsed.schemaVersion !== "governed-action-claim/v1" ||
        typeof parsed.actionDigest !== "string" ||
        typeof parsed.claimId !== "string" ||
        typeof parsed.ownerPid !== "number" ||
        typeof parsed.claimedAt !== "string" ||
        !(parsed.checkpoint === null || typeof parsed.checkpoint === "object")
      ) return null;
      return parsed as ActiveClaim;
    } catch {
      return null;
    }
  }

  private async replaceActive(path: string, active: ActiveClaim): Promise<void> {
    const temporary = join(dirname(path), `.${randomUUID()}.active.tmp`);
    await writeFile(temporary, `${JSON.stringify(active)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  private async readBinding(path: string): Promise<FileBinding> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        return JSON.parse(await readFile(path, "utf8")) as FileBinding;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new Error("Idempotency binding exists but could not be read.");
  }

  async claim(idempotencyKey: string, actionDigest: string): Promise<IdempotencyClaim> {
    await mkdir(this.bindingDirectory(), { recursive: true, mode: 0o700 });
    const bindingPath = this.bindingPath(idempotencyKey);
    const binding: FileBinding = { idempotencyKey, actionDigest };
    try {
      await writeFile(bindingPath, `${JSON.stringify(binding)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.readBinding(bindingPath);
      if (
        existing.idempotencyKey !== idempotencyKey ||
        existing.actionDigest !== actionDigest
      ) {
        return { status: "conflict" };
      }
    }

    const data = await this.read();
    const receiptId = data.idempotency[idempotencyKey];
    const receipt = data.receipts.find((candidate) => candidate.id === receiptId);
    if (receipt) return { status: "replay", receipt };

    const activePath = this.activePath(idempotencyKey);
    const active = newActiveClaim(actionDigest);
    try {
      await writeFile(activePath, `${JSON.stringify(active)}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const existing = await this.readActive(activePath);
        if (
          existing &&
          existing.actionDigest === actionDigest &&
          !processIsAlive(existing.ownerPid)
        ) {
          return {
            status: "orphaned",
            claimId: existing.claimId,
            checkpoint: existing.checkpoint,
          };
        }
        return { status: "in_progress" };
      }
      throw error;
    }
    return { status: "claimed", claimId: active.claimId };
  }

  async checkpoint(idempotencyKey: string, actionDigest: string, claimId: string, checkpoint: ClaimCheckpoint): Promise<void> {
    const path = this.activePath(idempotencyKey);
    const active = await this.readActive(path);
    if (!active || active.actionDigest !== actionDigest || active.claimId !== claimId) {
      throw new Error("Active idempotency claim changed before checkpoint.");
    }
    await this.replaceActive(path, { ...active, checkpoint });
  }

  async recoverOrphaned(idempotencyKey: string, actionDigest: string, claimId: string): Promise<{ claimId: string; checkpoint: ClaimCheckpoint | null } | null> {
    const recoveryPath = this.recoveryPath(idempotencyKey);
    let locked = false;
    for (let attempt = 0; attempt < 2 && !locked; attempt += 1) {
      try {
        await writeFile(recoveryPath, `${JSON.stringify({ ownerPid: process.pid })}\n`, { flag: "wx", mode: 0o600 });
        locked = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = JSON.parse(
          await readFile(recoveryPath, "utf8").catch(() => "{}"),
        ) as { ownerPid?: unknown };
        if (typeof owner.ownerPid !== "number" || processIsAlive(owner.ownerPid)) return null;
        await unlink(recoveryPath).catch(() => undefined);
      }
    }
    if (!locked) return null;
    try {
      const path = this.activePath(idempotencyKey);
      const active = await this.readActive(path);
      if (
        !active ||
        active.actionDigest !== actionDigest ||
        active.claimId !== claimId ||
        processIsAlive(active.ownerPid)
      ) return null;
      const recovered = newActiveClaim(actionDigest, active.checkpoint);
      await this.replaceActive(path, recovered);
      return { claimId: recovered.claimId, checkpoint: recovered.checkpoint };
    } finally {
      await unlink(recoveryPath).catch(() => undefined);
    }
  }

  async append(receipt: ExecutionReceipt, idempotencyKey: string): Promise<void> {
    try {
      const binding = await this.readBinding(this.bindingPath(idempotencyKey));
      if (
        binding.idempotencyKey !== idempotencyKey ||
        binding.actionDigest !== receipt.actionDigest
      ) {
        throw new Error("Receipt action digest does not match its idempotency binding.");
      }
      const data = await this.read();
      data.receipts.push(receipt);
      if (replayable(receipt)) data.idempotency[idempotencyKey] = receipt.id;
      await this.write(data);
    } finally {
      await unlink(this.activePath(idempotencyKey)).catch(() => undefined);
    }
  }

  async release(idempotencyKey: string, actionDigest: string): Promise<void> {
    const binding = await this.readBinding(this.bindingPath(idempotencyKey)).catch(
      () => null,
    );
    if (binding?.actionDigest === actionDigest) {
      await unlink(this.activePath(idempotencyKey)).catch(() => undefined);
    }
  }

  async list(): Promise<ExecutionReceipt[]> {
    return (await this.read()).receipts;
  }
}
