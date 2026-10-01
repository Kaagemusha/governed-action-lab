# How to put this in front of a real agent

This repository is a reference implementation, not a library you `npm
install` into production (see
[`docs/architecture.md`](architecture.md#threat-model-and-limits)). This page
is the honest version of "how would you actually do this": what to keep,
what to build, and what this pattern does not solve for you.

## 1. Keep the four-question split, drop nothing else

Can the tool act? Does policy allow it? Who authorizes it? Was it verified?
Keep these as four independently checkable decisions with their own typed
contracts, even if you don't keep a single line of this code. The value is in
the separation, not the specific schemas. If your agent framework currently
answers all four with one model call ("does this look safe to do?"), that is
the thing to change first.

## 2. Write your own closed action catalog

This repo's catalog has three actions because that's what fits a lab. A real
deployment's catalog is however many actions your agent is actually meant to
take. It is not "whatever the model can express in a tool call." Each entry
needs a typed schema, a `mutates`/`executable` flag, and ideally a
`saferAlternative` for anything red. Expect this to be the most
organizationally expensive step: someone has to enumerate what the agent is
for, in writing, before the policy layer can mean anything.

## 3. Build and review a real adapter; do not reuse the synthetic one

The synthetic adapter in this repo is root-confined, non-symlink-following,
and file-backed specifically so it can be public. A real adapter touches a
real system, which means real credentials, real blast radius, and a real
compensation story if verification fails partway through. This is not a
weekend task and should not be treated as one: budget for a security review
of the adapter specifically, separate from a review of the policy layer in
front of it.

## 4. Decide your evidence source and its freshness contract

Governed Action Lab consumes a `context-layer-diagnostic` packet. You don't
have to use Context Layer Lab specifically, but you do have to answer the
same question it answers: what evidence is this decision based on, how do
you know it's current, and what happens when it isn't? "The agent's last
message" is not an evidence source. See
[`docs/pair-walkthrough.md`](pair-walkthrough.md) for what a real evidence
handoff and a real staleness refusal look like end to end.

## 5. Decide what "human approval" means at your scale

A single operator typing `APPROVE` in a terminal (this repo's whole
interactive story) does not scale past a handful of daily actions. Before
this goes anywhere near production you need three things. First, an actual
identity provider behind "who approved this". This repo's CLI and MCP server
use a fixed synthetic identity (see
[`docs/architecture.md`](architecture.md#contracts)); there is no
authentication here at all. Second, a real notification path so a human sees
the approval request inside its five-minute window. Third, a policy for what
happens when no human is available in time. This repo's answer is "the
approval expires and the action does not run". Decide if that's your answer
too.

## Mapping to autonomy levels (L0 to L4)

Autonomy levels are a common way to describe how much an agent may do without
a human in the loop. This is how the pattern maps onto them, and where this
repository stops.

| Level | Meaning | In this repo | Not in this repo |
|---|---|---|---|
| L0 | Observe and report | Green `inspect_run_receipt`: read-only, verified, receipted | |
| L1 | Recommend only | `propose`, `prepare`, `simulate`: a review packet, nothing executes | |
| L2 | Act with an exact per-action approval | Yellow `retry_failed_lane`: single-use, five-minute grant bound to one request and one decision | Real approver identity |
| L3 | Act inside a pre-approved envelope | Parts only: resource allowlists, evidence freshness, receipts, verification, compensation | Numeric parameter envelopes (maximum change per action or per day), rate or budget counters. Every mutation still needs its own approval. |
| L4 | Act within policy, review after | Hard limits only: closed catalog, red actions structurally unexecutable | Unattended mutation, post-hoc review queue, anchored audit log |

The repo is an L2 implementation with L0 and L1 underneath it. Moving to L3
means adding typed numeric bounds to the catalog and a durable counter the
executor checks before each effect. Treat that as new design work, not a
configuration change.

## Checklist for any system that admits agent writes

This lab's failure modes double as audit questions for any system that
admits writes from agents or automation:

- **Can a writer touch this target at all?** What is permitted should be a
  named, bounded set, not "whatever the caller can express" (see
  [ADR 1](adr/0001-closed-action-catalog.md)).
- **Does policy allow this specific write, right now?** A write to a shared
  or changing target should pass an admission check before it happens, not
  be reconciled after.
- **Who is answerable for this write?** Every write should run under a
  verified identity that matches the declared proposer (see
  `CONFUSED_DEPUTY` in [`docs/attack-matrix.md`](attack-matrix.md)).
- **Was the change verified before it counted as done?** "The adapter
  reported success" is not the same as "before and after state confirm it"
  (see [ADR 3](adr/0003-receipts-hash-before-after-state.md)).
- **Would a widened or substituted write still pass admission?** Can a
  completed transaction be replayed? Can a policy be swapped for one with the
  same name? Each named attack in
  [`docs/attack-matrix.md`](attack-matrix.md) is a question worth asking of
  your own system.

## What you would still need to add

This list is deliberately not a roadmap. It's the honest gap between a
reference implementation and a production system, spelled out so you don't
discover it after you've already shipped:

- **RBAC and multi-tenancy.** This repo has one policy, one fixed synthetic
  identity, and no notion of which human is allowed to approve which action
  class. A real deployment needs role-scoped approval authority.
- **External, tamper-evident audit anchoring.** Receipt digests prove
  internal consistency of one presented receipt. They do not prove the
  receipt store itself hasn't had entries deleted or reordered, and nothing
  here anchors receipts to an external, independently-controlled log. See
  [ADR 3](adr/0003-receipts-hash-before-after-state.md) for exactly what the
  digest does and doesn't cover.
- **Embeddings or better retrieval, if your evidence corpus is large.**
  Context Layer Lab is lexical (BM25F) on purpose at its current scale; see
  its own [design decisions](https://github.com/Kaagemusha/context-layer-lab/blob/main/docs/architecture.md#design-decisions).
  A large, heterogeneous evidence corpus is a different retrieval problem
  than this pattern solves.
- **Isolation between concurrent actions.** The idempotency and crash-recovery
  logic here is a single-host synthetic demonstration
  (see [`docs/architecture.md`](architecture.md#contracts)), not a
  distributed lease protocol.
- **A real security review of whatever adapter you write.** This cannot be
  outsourced to "the policy layer looked safe."

If your honest answer after reading this is "we need most of the list," that
is the correct read of a reference implementation. What it offers is a
tested shape for the four-question split, not a shortcut past the
engineering the list describes.
