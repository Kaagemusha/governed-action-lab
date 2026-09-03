# Operational proof

The [README](../README.md) states the headline claim. This page is the full
detail behind it.

Operational lineage: this pattern has been exercised in a private governed vault
workflow. This public repository remains synthetic, public-safe, and disconnected
from that workflow and from any production system.

The review path runs after a scheduled private context diagnostic. A supervised
10-case shadow pilot covered healthy, failed, preserved-local, missing, stale,
contradictory, mixed, unavailable-runtime, transition, and deterministic-replay
states. All cases passed without creating an approval or mutation artifact.

One bounded green action now runs privately after that review: it inspects one
hash-bound local evidence file through a root-confined, non-symlink, read-only
adapter and writes at most one immutable receipt per day. The live receipt
verified its schema and digest, carried no approval, matched the diagnostic's
source hash, and recorded identical before/after hashes. Immediate replay reused
the receipt and changed no files. Yellow execution remains disabled.

A separate supervised yellow proof ran only in the bundled synthetic sandbox.
The operator had to type the literal approval in an interactive terminal after
seeing the exact target, effect, evidence, expiry, and rollback contract. The
resulting five-minute, single-use grant bound the request and decision; execution
rechecked current state, wrote one synthetic retry record, and produced a valid
receipt. Replay returned that same receipt without a second effect. Compensation
was pre-authorized but not needed. No external system was connected or changed.

The public console uses synthetic data to show the same status and authority
boundary. Its green and yellow exports pass the real receipt schema and digest
verifier, include the complete precondition and timing fields, and identify the
adapter version as `browser-synthetic/1`. They remain browser-only simulations;
no private diagnostic, receipt, lane identifier, path, hostname, or operating
record is published in this repository.

## Portable proof packet

The repository also publishes one frozen, portable green proof packet at
[`governed-action-proof.json`](governed-action-proof.json). It embeds
the exact Context Layer v2 fixture, public policy 1.3.0, recomputed READY review,
and a successful approval-free receipt generated through the actual synthetic
executor's read path. Generate or verify byte-for-byte drift with:

```bash
npm run proof:sync
npm run proof:check
npm run action -- verify-proof --proof docs/governed-action-proof.json
```

`verifyPortableProof` validates strict schemas, frozen producer metadata,
canonical diagnostic and policy hashes, recomputed request/decision/review
semantics, read-only receipt invariants, nested digests, and the outer packet
digest. These digests demonstrate integrity and binding inside this artifact;
they are not signatures, authenticity claims, external audit anchors, or proof
that an external system was inspected. The packet contains no approval grant,
yellow execution, private path, hostname, or operating record.
The CLI verifier accepts any supplied packet, runs that same strict verifier,
and returns only a compact validity result and identity fields; it does not
execute the embedded action or replay the packet contents.
