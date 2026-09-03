# Architecture decision records

Each record is one decision: the context that forced it, the decision, and
the consequences accepted along with it. See
[`docs/architecture.md`](../architecture.md) for how the pieces fit together
and [`docs/attack-matrix.md`](../attack-matrix.md) for what each decision
defends against in practice.

1. [Closed action catalog, not natural-language classification](0001-closed-action-catalog.md)
2. [Single-use, short-lived, exact operator approvals](0002-single-use-approvals.md)
3. [Receipts hash before-and-after state](0003-receipts-hash-before-after-state.md)
4. [No production or network adapter ships in this public repo](0004-no-production-adapter.md)
5. [Injected clock, never a bare wall-clock read](0005-injected-clock.md)
6. [Canonical JSON and SHA-256 over default serialization](0006-canonical-json-digests.md)
7. [Approvals key on the (action, decision) digest pair, not the action alone](0007-approval-keyed-to-decision-pair.md)
