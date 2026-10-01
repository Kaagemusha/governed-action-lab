# Changelog

## Unreleased

**Console redesign.** The public console now matches antoine.nutu.net: dark
theme, the retry path first, a live five-step trace, a paper receipt whose
digest you can check and break, a forged-decision demo on the refused path,
and the 11-attack table. Fixes Escape approving a retry after an earlier
approval. No runtime, sample, or proof change.

## 1.2.0 (2026-10-01)

First release in this repository's current history. Earlier releases are
summarized below.

- **Neutral sample names.** The bundled Context Layer Lab fixtures, browser
  sample data, and portable proof packet were regenerated from the
  producer's renamed synthetic sample. Fixture metadata records the new
  producer commit and SHA-256. The CLI contract, packet formats, and policy
  semantics are unchanged. Package 1.2.0 still ships public policy 1.3.0.
- 36/36 evals (26 adversarial, 3 fault injection, 7 intended path) and 11/11
  named attacks pass.

## Earlier releases

- **1.1.0 (2026-09-27).** Each supported public policy version is pinned to
  the canonical digest of its exact manifest, so a same-name manifest with
  altered content is `UNKNOWN_POLICY` (new `PUBLIC_POLICY_IMPERSONATION`
  attack and eval case). Trusted decisions record `policy.manifestDigest`,
  and the executor compares it with the loaded policy, so decisions and
  approvals from earlier builds must be re-issued. Policy rule flags can no
  longer contradict their classification. Every eval case carries a `kind`.
  The CLI runs through a symlinked bin or a path containing a space, the MCP
  server reports the package version, and `npm run check` builds once and
  runs the attack demo.
- **1.0.0 (2026-09-03).** Restructured the README and moved the reference
  material into `docs/architecture.md`. Added `docs/pair-walkthrough.md` with
  a captured Context Layer Lab handoff, ten named attacks mapped to OWASP LLM
  Top 10 2025, MITRE ATLAS, or CWE in `docs/attack-matrix.md`, seven ADRs,
  `docs/how-to-adopt.md`, contributing and citation files, and issue
  templates.
- **Before 1.0.0 (July and August 2026).** Strict governance contracts, the
  deterministic policy gate, the operator approval boundary, the bounded
  synthetic executor, the diagnostic adapter and CLI, the approval-free MCP
  transport, the local-first console, the public-safety release gate, and
  evidence-bound Context Layer diagnostic v2 as the public default.
