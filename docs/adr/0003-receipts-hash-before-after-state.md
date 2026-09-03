# 3. Receipts hash before-and-after state

## Status

Accepted.

## Context

"The action ran and returned success" is not evidence of what actually
changed. A receipt that only records a boolean result is trivially
satisfied by an adapter (or a bug) that reports success without doing
anything, or that mutates the wrong resource. A receipt worth trusting has
to describe a specific, checkable effect, and it has to be tamper-evident
itself — otherwise the receipt is just another unverified claim sitting next
to the one it was meant to verify.

## Decision

Every mutating effect the synthetic adapter reports (`AdapterEffect` in
`src/adapters/synthetic-automation.ts`) carries `beforeHash` and `afterHash` —
content hashes of the target resource immediately before and after the
effect. `createReceipt()` (`src/receipts.ts`) then computes a
`receiptDigest` over the full canonical receipt content (id, actionId,
digests, adapter identity, timestamps, result, effects, verification,
compensation) using the same canonical-JSON SHA-256 scheme as everything else
in the system (see [ADR 6](0006-canonical-json-digests.md)). `verifyReceipt()`
recomputes that digest and compares it to the stored one; a receipt whose
content was edited after the fact — even a single field, like flipping
`result` from `"succeeded"` to `"failed"` — fails verification.

## Consequences

- A receipt proves *what specific state transition* occurred, not just that
  a function returned without throwing. A reviewer (or an automated check)
  can confirm the before/after hashes against the actual resource
  independently of the receipt's own narrative.
- Tampering the receipt after it is written is detectable —
  `RECEIPT_CONTENT_TAMPERING` in
  [`docs/attack-matrix.md`](../attack-matrix.md) — but detection is not
  prevention. The verifier checks one presented receipt's internal
  consistency; it does not defend against a process that controls the
  machine and can rewrite the receipt store wholesale, and it cannot detect
  whole-receipt deletion from a store's history. See
  [`docs/architecture.md`](../architecture.md#contracts) for the exact limits
  of what digest verification does and doesn't cover.
- Read-only actions still produce a receipt with an empty `effects` array
  and a verification result, so "nothing changed" is itself a checkable,
  timestamped claim rather than silence.
