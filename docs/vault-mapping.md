# Where this pattern comes from

This repository is a portable, public write-up of a pattern the author
already runs in a private knowledge-management system, generalized here with
no private paths, hostnames, or internal names. The write-admission
discipline described below predates this repository; this repository is the
reusable, inspectable version of it.

## The pattern, generically

A private, multi-writer document system needs the same four questions this
lab asks of any agent action:

- **Can a writer touch this path at all?** Some areas are open by default;
  others are restricted and require an explicit scope grant before any
  write is attempted — the same shape as this lab's closed action catalog
  (see [ADR 1](adr/0001-closed-action-catalog.md)): what's permitted is a
  named, bounded set, not "whatever the caller can express."
- **Does policy allow this specific write, right now?** A write to a shared
  or actively-changing path has to pass an admission check — begin a
  transaction, get admitted only if no conflicting writer is mid-flight, and
  hold that admission through the actual write — rather than writing first
  and reconciling conflicts after.
- **Who is answerable for this transaction?** Every write happens under a
  tracked session identity, the same way this lab's executor requires a
  verified principal that matches the request's declared proposer (see
  `CONFUSED_DEPUTY` in [`docs/attack-matrix.md`](attack-matrix.md)) — not
  "some process wrote this," but "this specific tracked writer wrote this."
- **Was the change verified before it counted as done?** A transaction is
  only complete once the change is confirmed to have reached the shared,
  canonical state — not once the local write call returns — the same
  distinction this lab draws between "the adapter reported success" and "the
  before/after hashes and verification step confirm it" (see [ADR
  3](adr/0003-receipts-hash-before-after-state.md)).

## What's the same, and what's deliberately not

The shapes match: bounded catalog, admission before write, tracked identity,
verify-then-close. What doesn't transfer directly: the private system
predates typed schemas and cryptographic receipts for every transaction —
it's process and convention enforced by tooling, not typed contracts checked
by a policy engine the way this lab's `evaluateAction` is. This repository
is, among other things, what building that same discipline as an explicit,
testable, typed system looks like once you write it down from scratch
instead of growing it path by path.

## What this means going the other direction

The interesting direction isn't "prove the private system is like this
lab" — it's the reverse: this lab's failure modes are a checklist for
auditing any write-admission system, private or public. If a system can't
answer "who has this held path locked, and for what," "would a widened or
substituted write still pass admission," or "can a completed transaction be
replayed," it's missing a control this lab makes structurally impossible to
skip. See [`docs/attack-matrix.md`](attack-matrix.md) for the specific
questions worth asking your own system.
