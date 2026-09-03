# 4. No production or network adapter ships in this public repo

## Status

Accepted.

## Context

The fastest way to make this lab look impressive is to point it at something
real: a live queue, a real deployment target, a real filesystem outside a
sandbox. That is also the fastest way to turn a portfolio artifact into a
liability — a public repository with any credentialed, network-reaching, or
destructive adapter is an attack surface the moment it exists, regardless of
how well the policy layer in front of it is designed. Governance around a
dangerous action is not the same claim as "this action is safe to expose
publicly."

## Decision

The only adapter in this repository is `SyntheticAutomationAdapter`
(`src/adapters/synthetic-automation.ts`): a file-backed, root-confined,
non-symlink-following sandbox under a temp or explicitly configured local
directory. `AGENTS.md` states the rule directly for anyone (human or agent)
working in this codebase: never add a production, network, repository,
deployment, communication, credential, financial, account, or deletion
adapter. The `delete_preserved_output` action exists in the catalog
specifically to demonstrate the red path — and its policy rule
(`rule.delete.refuse`) sets `adapterId: null`, so it is structurally
unexecutable regardless of approval, not merely denied by convention.

## Consequences

- The lab cannot demonstrate governance over a real system inside this
  repository, only the orchestration semantics: evidence binding, approval
  binding, state recheck, receipt verification. That is a real, named limit
  — see [`docs/architecture.md`](../architecture.md#threat-model-and-limits).
- The "operational proof" section
  ([`docs/operational-proof.md`](../operational-proof.md)) describes what
  running this same pattern against one bounded, read-only, hash-verified
  private adapter looks like — outside this repository, never merged into
  it, and still with no yellow (mutating) execution enabled.
- Anyone adopting this pattern has to write and review their own adapter.
  [`docs/how-to-adopt.md`](../how-to-adopt.md) is explicit that this is the
  hard, non-optional part of putting the pattern in front of a real system.
