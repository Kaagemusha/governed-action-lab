# 7. Approvals key on the (action, decision) digest pair, not the action alone

## Status

Accepted.

## Context

Keying an approval to just the action request's digest would mean "the human
approved this exact request" — but it would not mean the human approved it
*under the policy evaluation that was current at the time*. If the policy
changed between when the decision was shown to the operator and when the
grant is redeemed, keying on the action alone would let an old approval carry
forward into a new policy context the operator never saw and never approved.

## Decision

`ApprovalGrant` (`src/contracts.ts`) carries both `actionDigest` and
`decisionDigest`. `ApprovalStore.find()` looks up a grant by the pair, not by
either digest alone. `OperatorApprovalProvider.issue()` additionally verifies,
before minting a grant, that the decision it was handed is bound to the
request (`decision.actionDigest === actionDigest(request)`) and that the
decision's own content matches its own `decisionDigest`
(`digestOmitting(decision, "decisionDigest") === decision.decisionDigest`) —
so a caller cannot mint an approval against a decision object that was itself
tampered before being shown to the operator.

## Consequences

- A policy change — a new version, a tampered manifest, a different trust
  binding — invalidates outstanding approvals for the same action, because
  the decision digest they were keyed to no longer matches what a fresh
  evaluation produces. See `POLICY_MANIFEST_TAMPERING` in
  [`docs/attack-matrix.md`](../attack-matrix.md).
- This makes the approval strictly narrower than "approval for this action
  under any policy," which is the more conservative and correct default for
  a human-in-the-loop control — an operator approving a five-minute-old
  policy evaluation should not be treated as having approved whatever policy
  happens to be loaded next.
- It means a legitimate policy hot-reload between decision and execution — 
  even a benign one — forces a fresh decision and a fresh approval. There is
  no fast path for "the policy changed but only in a way that doesn't affect
  this rule"; the check is structural, not semantic.
