# Changelog

## v1.0.0 — 2026-09-03

Legibility pass. No behavior, contract, or policy change — this release makes
the existing system easier to evaluate in twenty seconds.

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
