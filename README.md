# Governed Action Lab

A small, inspectable reference implementation showing that an agent's proposed
action is not authorization.

**Intended console:** <https://kaagemusha.github.io/governed-action-lab/>

The lab places a deterministic governance boundary between a typed proposal and
an executor. It makes evidence, policy, authority, execution, verification, and
rollback inspectable without granting an agent the ability to approve its own
mutation.

## The failure it prevents

An agent may have access to a tool and current evidence without having authority
to use that tool. Treating capability as permission collapses three different
questions:

```text
Can the tool perform this effect?
Does policy allow this exact effect?
Who may authorize it?
```

Governed Action Lab keeps those questions separate. The policy engine uses a
closed action catalog, never a model or free-form shell analysis.

## Three paths

The public scenario is synthetic:

| Proposed action | Class | Disposition | Executable path |
|---|---|---|---|
| Inspect a failed run receipt | Green | Allow | Read-only adapter |
| Retry the failed lane | Yellow | Approval required | Exact, expiring, single-use human approval followed by a reversible sandbox adapter |
| Delete preserved output | Red | Refuse | None; approval cannot override refusal |

The console presents all three paths without navigation. Browser execution is
explicitly a synthetic demonstration and never touches an external system.

## Two-minute quick start

Requires Node.js 22 or newer.

```bash
npm install
npm run check
npm run action -- demo --json
```

Serve `docs/` with any static file server to use the local-first console.

Artifact-oriented commands:

```bash
npm run action -- propose \
  --diagnostic examples/context-layer-diagnostic.json \
  --action retry_failed_lane \
  --lane site-refresh \
  --output /tmp/action-request.json

npm run action -- evaluate \
  --diagnostic examples/context-layer-diagnostic.json \
  --request /tmp/action-request.json \
  --output /tmp/action-decision.json
```

`approve` is an interactive operator command. It displays the exact target,
effect, evidence, five-minute expiry, and rollback contract before accepting
the literal confirmation `APPROVE`. `execute` discovers a separately stored
approval and rejects `--approve`, `--yes`, and inline approval text.

## Context Layer Lab relationship

[Context Layer Lab](https://github.com/Kaagemusha/context-layer-lab) answers:
**what current evidence supports the conclusion?**

Governed Action Lab answers: **given that evidence, what may execute, under
whose authority, and with what receipt?**

The frozen public fixture consumes `context-layer-diagnostic/v1` from producer
commit `b0179a8e365ab35691864e55d5792db1bdefbcb2`. The consumer validates the
complete packet, binds the request to its SHA-256 digest, and independently
checks the selected lane's latest raw receipt. It does not import sibling source
files or duplicate the producer's broader health logic.

```text
Context diagnostic v1
  -> strict consumer adapter
  -> typed action request
  -> deterministic policy gate
  -> allow / approval boundary / refusal
  -> precondition recheck
  -> allowlisted synthetic adapter
  -> verification and append-only receipt
```

## Architecture

```mermaid
flowchart LR
    C["Context diagnostic v1"] --> A["Strict context adapter"]
    A --> Q["Typed action request"]
    Q --> P["Deterministic policy"]
    P -->|green| X["Allowlisted adapter"]
    P -->|yellow| H["Operator approval provider"]
    P -->|red| F["Refusal receipt"]
    H --> B["Exact single-use grant"]
    B --> R["Freshness + state recheck"]
    R --> X
    X --> V["Deterministic verification"]
    X -->|partial failure| K["Pre-authorized compensation"]
    V --> E["Append-only receipt"]
    K --> E
    M["Agent-facing MCP"] --> P
    M --> X
```

The contracts, canonical hashing, context adapter, policy, approval provider,
executor, sandbox adapter, stores, CLI, MCP server, and browser are separate
layers. Browser decisions are compiled from the same core policy code rather
than reimplemented.

## Contracts

Strict Zod schemas reject unknown keys at persisted and transport boundaries:

- `governed-action-request/v1`
- `governed-action-decision/v1`
- `governed-action-approval/v1`
- `governed-action-receipt/v1`
- `governed-action-policy/v1`
- frozen consumer for `context-layer-diagnostic/v1`

Canonical JSON recursively sorts keys and rejects non-JSON values before
SHA-256 hashing. An approval binds both the complete request digest and the
decision digest. Receipts describe bounded resources and before/after hashes.

Receipts are append-only in this implementation, not tamper-proof audit logs.
Digest verification detects changed content; it does not defend against a
process that controls the machine and can rewrite both data and code.

## MCP tools

| Tool | Effect |
|---|---|
| `evaluate_action` | Read-only validation and policy evaluation |
| `explain_action_decision` | Read-only explanation |
| `simulate_action` | Read-only projected effect |
| `execute_approved_action` | Synthetic sandbox only; requires a separate stored approval |
| `verify_action_receipt` | Read-only schema and digest verification |

There is no approval-creation MCP tool. The executor tool accepts an action
identifier, not an approval payload or command string.

## Evaluations

`npm run eval` executes 31 deterministic adversarial cases and compares actual
structured output with explicit expected output. Coverage includes:

- unknown action, adapter, environment, diagnostic, and command-shaped input;
- green mutation mismatch and red action with a valid-looking approval;
- changed, expired, replayed, tampered, and earlier-decision approvals;
- evidence expiry, missing evidence, invalid quality, contradictory
  assessments, and newer success before retry;
- idempotency, failures before and after effect, compensation, verification
  mismatch, and tampered receipts;
- absent approval providers, MCP capability limits, forged browser decisions,
  generated-demo drift, and policy change after approval.

`npm run qa:responsive` launches an isolated local Chrome instance and asserts
that the document and every rendered element remain within 320, 375, and 390px
viewports.

## Threat model and limits

The lab demonstrates deterministic refusal and approval binding. It does not
provide:

- production authorization, OAuth, RBAC, multi-tenancy, or machine isolation;
- a security boundary against a process already controlling the local machine;
- tamper-proof or externally anchored audit logs;
- proof that supplied evidence is factually true;
- a production, network, repository, deployment, communication, credential,
  financial, account, or deletion adapter;
- natural-language risk classification or arbitrary command execution;
- a replacement for Context Layer Lab retrieval or a private write-admission
  protocol.

Freshness means evidence remains within its declared time boundary. It is not a
truth score. The public synthetic executor proves orchestration semantics, not
production safety.

## Repository map

```text
data/       fixed public policy
docs/       dependency-light local-first console
evals/      explicit adversarial expectations
examples/   synthetic diagnostic and fixture metadata
scripts/    generated-runtime, drift, responsive, and public-safety gates
src/        contracts and independent governance layers
test/       unit and protocol contract tests
```

## Development checks

```bash
npm run typecheck
npm test
npm run eval
npm run demo:check
npm run qa:responsive
npm run public-safety:check
npm run check
```

`npm run check` is network-independent after installation. Runtime files and
the public sample are generated deterministically; drift fails the gate.

## Rollback

Each implementation phase is a separate commit. Revert the smallest phase
commit rather than resetting unrelated work:

```bash
git revert <phase-commit>
```

## License

MIT
