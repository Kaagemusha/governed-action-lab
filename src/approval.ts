import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { digestOmitting } from "./canonical.js";
import {
  APPROVAL_VERSION,
  actionRequestSchema,
  approvalGrantSchema,
  policyDecisionSchema,
  type ApprovalGrant,
} from "./contracts.js";
import { actionDigest, type Clock, systemClock } from "./policy.js";

export type ApprovalValidation =
  | { valid: true; grant: ApprovalGrant }
  | { valid: false; code: "missing" | "tampered" | "scope_mismatch" | "expired" | "replayed" };

export interface ApprovalStore {
  find(actionDigest: string, decisionDigest: string): Promise<ApprovalGrant | null>;
  save(grant: ApprovalGrant): Promise<void>;
  consume(grant: ApprovalGrant): Promise<boolean>;
}

export class MemoryApprovalStore implements ApprovalStore {
  readonly grants = new Map<string, ApprovalGrant>();
  readonly consumed = new Set<string>();

  async find(actionHash: string, decisionHash: string): Promise<ApprovalGrant | null> {
    return (
      [...this.grants.values()].find(
        (grant) => grant.actionDigest === actionHash && grant.decisionDigest === decisionHash,
      ) ?? null
    );
  }

  async save(grant: ApprovalGrant): Promise<void> {
    this.grants.set(grant.id, structuredClone(grant));
  }

  async consume(grant: ApprovalGrant): Promise<boolean> {
    if (this.consumed.has(grant.id)) return false;
    this.consumed.add(grant.id);
    return true;
  }
}

type ApprovalFile = { grants: ApprovalGrant[]; consumedIds: string[] };

export class FileApprovalStore implements ApprovalStore {
  constructor(readonly path: string) {}

  private async read(): Promise<ApprovalFile> {
    const parsed = JSON.parse(await readFile(this.path, "utf8").catch(() => '{"grants":[],"consumedIds":[]}')) as ApprovalFile;
    return {
      grants: parsed.grants.map((grant) => approvalGrantSchema.parse(grant)),
      consumedIds: parsed.consumedIds,
    };
  }

  private async write(value: ApprovalFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(this.path), `.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }

  async find(actionHash: string, decisionHash: string): Promise<ApprovalGrant | null> {
    const data = await this.read();
    return (
      data.grants.find(
        (grant) => grant.actionDigest === actionHash && grant.decisionDigest === decisionHash,
      ) ?? null
    );
  }

  async save(grant: ApprovalGrant): Promise<void> {
    const data = await this.read();
    data.grants.push(grant);
    await this.write(data);
  }

  async consume(grant: ApprovalGrant): Promise<boolean> {
    const consumedDirectory = join(dirname(this.path), ".consumed");
    const marker = join(consumedDirectory, encodeURIComponent(grant.id));
    await mkdir(consumedDirectory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(marker, `${grant.grantDigest}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }

    const data = await this.read();
    if (!data.consumedIds.includes(grant.id)) data.consumedIds.push(grant.id);
    await this.write(data);
    return true;
  }
}

export class OperatorApprovalProvider {
  constructor(
    private readonly store: ApprovalStore,
    private readonly clock: Clock = systemClock,
  ) {}

  async issue(
    requestInput: unknown,
    decisionInput: unknown,
    operatorId: string,
    confirmed: true,
    lifetimeSeconds = 300,
  ): Promise<ApprovalGrant> {
    const request = actionRequestSchema.parse(requestInput);
    const decision = policyDecisionSchema.parse(decisionInput);
    if (!confirmed || decision.classification !== "yellow" || decision.disposition !== "approval_required") {
      throw new Error("Only a confirmed operator may approve an approval-required yellow decision.");
    }
    if (decision.actionDigest !== actionDigest(request)) {
      throw new Error("Decision is not bound to this action request.");
    }
    if (digestOmitting(decision, "decisionDigest") !== decision.decisionDigest) {
      throw new Error("Decision digest does not match its contents.");
    }
    const approvedAt = this.clock.now();
    const partial = {
      schemaVersion: APPROVAL_VERSION,
      id: `approval-${randomUUID()}`,
      actionDigest: decision.actionDigest,
      decisionDigest: decision.decisionDigest,
      approvedBy: operatorId,
      approvedAt: approvedAt.toISOString(),
      expiresAt: new Date(approvedAt.getTime() + Math.min(lifetimeSeconds, 300) * 1000).toISOString(),
      singleUse: true,
      failureCompensationAuthorized: true,
      grantDigest: "0".repeat(64),
    } satisfies ApprovalGrant;
    partial.grantDigest = digestOmitting(partial, "grantDigest");
    const grant = approvalGrantSchema.parse(partial);
    await this.store.save(grant);
    return grant;
  }
}

export async function validateAndConsumeApproval(
  store: ApprovalStore | null,
  requestInput: unknown,
  decisionInput: unknown,
  clock: Clock = systemClock,
): Promise<ApprovalValidation> {
  const validation = await validateApproval(store, requestInput, decisionInput, clock);
  if (!validation.valid) return validation;
  if (!store || !(await store.consume(validation.grant))) return { valid: false, code: "replayed" };
  return validation;
}

export async function validateApproval(
  store: ApprovalStore | null,
  requestInput: unknown,
  decisionInput: unknown,
  clock: Clock = systemClock,
): Promise<ApprovalValidation> {
  const request = actionRequestSchema.parse(requestInput);
  const decision = policyDecisionSchema.parse(decisionInput);
  if (!store) return { valid: false, code: "missing" };
  const grantInput = await store.find(actionDigest(request), decision.decisionDigest);
  if (!grantInput) return { valid: false, code: "missing" };
  const parsedGrant = approvalGrantSchema.safeParse(grantInput);
  if (!parsedGrant.success) return { valid: false, code: "tampered" };
  const grant = parsedGrant.data;
  if (digestOmitting(grant, "grantDigest") !== grant.grantDigest) return { valid: false, code: "tampered" };
  if (grant.actionDigest !== actionDigest(request) || grant.decisionDigest !== decision.decisionDigest) {
    return { valid: false, code: "scope_mismatch" };
  }
  if (new Date(grant.expiresAt).getTime() <= clock.now().getTime()) {
    return { valid: false, code: "expired" };
  }
  return { valid: true, grant };
}
