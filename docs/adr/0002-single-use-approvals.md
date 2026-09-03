# 2. Single-use, short-lived, exact operator approvals

## Status

Accepted.

## Context

A "yes" from a human is only as strong as what it's bound to and how long it
stays valid. A reusable approval token, or one bound loosely to "this kind of
action" rather than this exact action, turns one moment of human judgment
into a standing grant an agent (or an attacker who captures the token) can
spend more than once, or spend on something the human never actually saw.

## Decision

`OperatorApprovalProvider.issue()` (`src/approval.ts`) only mints a grant when
the caller passes a literal `confirmed: true` and the decision is genuinely
`classification: "yellow"` / `disposition: "approval_required"`. The grant
(`approvalGrantSchema`) binds `actionDigest` and `decisionDigest` — the full
canonical hash of the specific request and the specific policy decision, not
an action type or a resource name. It carries a hard `expiresAt`, capped at
the policy rule's `maxApprovalLifetimeSeconds` (5 minutes for the retry
action), and `singleUse: true` is enforced structurally, not just by
convention: `ApprovalStore.consume()` must succeed exactly once (the
file-backed store uses an atomic, exclusive-create marker file so two
concurrent executions cannot both consume the same grant).

## Decision, continued: what the operator sees

The CLI's `approve` command (`src/cli.ts`) refuses to run outside a real TTY
and prints the exact target, effect, evidence, expiry, and rollback contract
before accepting the literal string `APPROVE` — not `--yes`, not a piped
confirmation. See [`docs/pair-walkthrough.md`](../pair-walkthrough.md) for
what that looks like against real output.

## Consequences

- An approval cannot be widened, transferred to a different request, or
  reused after a successful execution — see `APPROVAL_REPLAY` and
  `APPROVAL_SCOPE_WIDENING` in [`docs/attack-matrix.md`](../attack-matrix.md).
- An approval issued and then not used within 5 minutes is dead. There is no
  renewal path; the operator must review and approve again from current
  state. This is deliberate friction, not an oversight.
- The approval step cannot be scripted end-to-end without a real interactive
  terminal, which makes CI unable to fully rehearse the yellow path
  automatically — the eval suite exercises the approval and executor code
  directly instead of shelling out to the CLI for that step.
