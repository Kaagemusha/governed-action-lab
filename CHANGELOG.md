# Changelog

## v1.0.0 — 2026-09-03

No change to the CLI contract, packet formats, or policy semantics
(`npm run contract:check` and `npm run proof:check` pass unchanged). This
release makes the existing system easier to evaluate in twenty seconds, and
adds real evidence for the two claims that matter most: what it defends
against, and why it's built the way it is.

**Legibility pass**

- Rewrote `README.md` above the fold: one-line claim, console screenshot and
  GIF, "the failure it prevents," "what this proves," live-demo link, quick
  start. Moved the disclaimer and deep reference material below the fold.
- Split deep content into [`docs/architecture.md`](docs/architecture.md) and
  [`docs/operational-proof.md`](docs/operational-proof.md).
- Added [`docs/pair-walkthrough.md`](docs/pair-walkthrough.md): the real,
  captured, copy-pasteable Context Layer Lab → Governed Action Lab command
  sequence, including a genuine stale-evidence refusal at `execute`.
- Added a "Two labs, one boundary" cross-link section, matching
  `context-layer-lab`'s README.
- Added `CONTRIBUTING.md`, `CITATION.cff`, and issue templates (bug, new
  attack case, new eval case).
- Added CI, Node, eval-count, and attack-count badges to the README header.

**Attack matrix and ADRs**

- Expanded `npm run demo:attacks` from 5 to 10 named attacks (expired-approval
  reuse, canonicalization/homoglyph bypass, approval scope widening,
  policy-manifest tampering via trust-binding digest mismatch, idempotency-key
  collision), each run against the real code path.
- Added [`docs/attack-matrix.md`](docs/attack-matrix.md): all 10 attacks
  mapped to OWASP LLM Top 10 2025, MITRE ATLAS, or CWE, with the defended
  layer and test per row.
- Added [`docs/adr/`](docs/adr/): 7 architecture decision records.
- Added [`docs/how-to-adopt.md`](docs/how-to-adopt.md) and
  [`docs/talk-track.md`](docs/talk-track.md).
- Added [`docs/vault-mapping.md`](docs/vault-mapping.md): where this pattern
  generalizes from, in generic terms.
