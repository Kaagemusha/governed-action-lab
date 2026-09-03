# 6. Canonical JSON and SHA-256 over default serialization

## Status

Accepted.

## Context

Every binding in this system — approval to request, receipt to its own
content, policy trust to a manifest — is a digest comparison. `JSON.stringify`
is not a safe basis for that: key order is insertion order, not guaranteed
stable across two independently-constructed objects that are logically
identical, and `undefined` values are silently dropped rather than rejected.
Two representations of "the same data" could hash differently, or a field
quietly missing from one side could hash the same as if it were present —
either failure mode breaks the entire binding chain silently.

## Decision

`src/canonical.ts` implements `canonicalJson()`: a recursive serializer that
sorts object keys, rejects `undefined` values and non-plain objects outright
(throwing rather than silently dropping data), and rejects non-finite
numbers. `sha256()` hashes the canonical form using a from-scratch SHA-256
implementation with no runtime crypto dependency. `digestOmitting()` computes
a digest of an object with one field (typically the digest field itself)
removed, which is how self-referential digests — a receipt's own
`receiptDigest`, an approval's own `grantDigest` — work: compute everything
else, hash it, then store the hash alongside the content it describes.

## Consequences

- Two independently constructed requests, decisions, or receipts with the
  same logical content always produce the same digest, regardless of
  construction order — this is what makes `actionDigest(request)` a reliable
  binding key rather than a coincidence.
- A field that would silently vanish under naive JSON handling instead
  throws during canonicalization. That is a deliberately loud failure mode:
  a malformed object never hashes successfully instead of hashing to a
  misleadingly "valid-looking" digest.
- Implementing SHA-256 from scratch instead of using Node's `crypto` module
  is unusual for production code, and is not a security recommendation — it
  keeps the reference implementation dependency-light and inspectable end to
  end in one file, which matters more for a teaching artifact than for a
  system that needs an audited, hardware-accelerated implementation.
