import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { digestOmitting } from "./canonical.js";
import {
  APPROVAL_VERSION,
  approvalGrantSchema,
  type ActionRequest,
  type ApprovalGrant,
  type PolicyDecision,
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
    const data = await this.read();
    if (data.consumedIds.includes(grant.id)) return false;
    data.consumedIds.push(grant.id);
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
    request: ActionRequest,
    decision: PolicyDecision,
    operatorId: string,
    confirmed: true,
    lifetimeSeconds = 300,
  ): Promise<ApprovalGrant> {
    if (!confirmed || decision.classification !== "yellow" || decision.disposition !== "approval_required") {
      throw new Error("Only a confirmed operator may approve an approval-required yellow decision.");
    }
    if (decision.actionDigest !== actionDigest(request)) {
      throw new Error("Decision is not bound to this action request.");
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
  request: ActionRequest,
  decision: PolicyDecision,
  clock: Clock = systemClock,
): Promise<ApprovalValidation> {
  if (!store) return { valid: false, code: "missing" };
  const grant = await store.find(actionDigest(request), decision.decisionDigest);
  if (!grant) return { valid: false, code: "missing" };
  if (digestOmitting(grant, "grantDigest") !== grant.grantDigest) return { valid: false, code: "tampered" };
  if (grant.actionDigest !== actionDigest(request) || grant.decisionDigest !== decision.decisionDigest) {
    return { valid: false, code: "scope_mismatch" };
  }
  if (new Date(grant.expiresAt).getTime() <= clock.now().getTime()) {
    return { valid: false, code: "expired" };
  }
  if (!(await store.consume(grant))) return { valid: false, code: "replayed" };
  return { valid: true, grant };
}
