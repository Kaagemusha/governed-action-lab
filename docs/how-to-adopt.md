# How to put this in front of a real agent

This repository is a reference implementation, not a library you `npm
install` into production (see
[`docs/architecture.md`](architecture.md#threat-model-and-limits)). This page
is the honest version of "how would you actually do this": what to keep,
what to build, and what this pattern does not solve for you.

## 1. Keep the four-question split, drop nothing else

Can the tool act, does policy allow it, who authorizes it, was it verified —
keep these as four independently checkable decisions with their own typed
contracts, even if you don't keep a single line of this code. The value is in
the separation, not the specific schemas. If your agent framework currently
answers all four with one model call ("does this look safe to do?"), that is
the thing to change first.

## 2. Write your own closed action catalog

This repo's catalog has three actions because that's what fits a lab. A real
deployment's catalog is however many actions your agent is actually meant to
take — not "whatever the model can express in a tool call." Each entry needs
a typed schema, a `mutates`/`executable` flag, and ideally a
`saferAlternative` for anything red. Expect this to be the most
organizationally expensive step: someone has to enumerate what the agent is
for, in writing, before the policy layer can mean anything.

## 3. Build and review a real adapter — do not reuse the synthetic one

The synthetic adapter in this repo is root-confined, non-symlink-following,
and file-backed specifically so it can be public. A real adapter touches a
real system, which means real credentials, real blast radius, and a real
compensation story if verification fails partway through. This is not a
weekend task and should not be treated as one: budget for a security review
of the adapter specifically, separate from a review of the policy layer in
front of it.

## 4. Decide your evidence source and its freshness contract

Governed Action Lab consumes a `context-layer-diagnostic` packet; you don't
have to use Context Layer Lab specifically, but you do have to answer the
same question it answers: what evidence is this decision based on, how do
you know it's current, and what happens when it isn't? "The agent's last
message" is not an evidence source. See
[`docs/pair-walkthrough.md`](pair-walkthrough.md) for what a real evidence
handoff and a real staleness refusal look like end to end.

## 5. Decide what "human approval" means at your scale

A single operator typing `APPROVE` in a terminal (this repo's whole
interactive story) does not scale past a handful of daily actions. Before
this goes anywhere near production you need: an actual identity provider
behind "who approved this" (this repo's CLI and MCP server use a fixed
synthetic identity — see [`docs/architecture.md`](architecture.md#contracts)
— there is no authentication here at all), a real notification path so a
human sees the approval request inside its five-minute window, and a policy
for what happens when no human is available in time (this repo's answer is
"the approval expires and the action does not run" — decide if that's your
answer too).

## What you would still need to add

This list is deliberately not "roadmap items" — it's the honest gap between
a reference implementation and a production system, spelled out so you don't
discover it after you've already shipped:

- **RBAC and multi-tenancy.** This repo has one policy, one fixed synthetic
  identity, and no notion of which human is allowed to approve which action
  class. A real deployment needs role-scoped approval authority.
- **External, tamper-evident audit anchoring.** Receipt digests prove
  internal consistency of one presented receipt; they do not prove the
  receipt store itself hasn't had entries deleted or reordered, and nothing
  here anchors receipts to an external, independently-controlled log. See
  [ADR 3](adr/0003-receipts-hash-before-after-state.md) for exactly what the
  digest does and doesn't cover.
- **Embeddings or better retrieval, if your evidence corpus is large.**
  Context Layer Lab is lexical (BM25F) on purpose at its current scale — see
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
is the correct read of a reference implementation — the value it offers is a
tested shape for the four-question split, not a shortcut past the
engineering the list describes.
