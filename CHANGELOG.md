# Changelog

## 1.2.3 (2026-10-02)

**No console warning under the security policy.** Zod probed `eval` on load,
which the page's Content Security Policy blocks; the page still worked but
logged a violation on every visit. The browser bundle now runs Zod in jitless
mode, so it never makes the probe.

**Browser check.** The headless-Chrome check now also fails if the page
reports a Content Security Policy violation or an uncaught error.

**Counts that cannot drift.** A new check recounts the evals and named attacks and
fails if the README badges or the console state different numbers.

## 1.2.2 (2026-10-02)

**Receipt store fixes.** Four defects in `FileReceiptStore`, found in
review, could each let an effect that had already happened run again:

- processes appending receipts for different keys at the same time could
  overwrite each other's receipts and replay mappings;
- a failed receipt write deleted the claim's recovery checkpoint;
- a retry could miss a receipt saved between its replay lookup and its claim;
- an unreadable replay mapping was treated as no receipt at all.

Each receipt and each replay mapping is now its own file; a claim is removed
only after its receipt is saved, and a failed save leaves it for crash
recovery; a new claim checks for a replay again before executing; and only a
missing file counts as "nothing stored", so other read errors fail closed. A
combined `receipts.json` from 1.2.1 or earlier is still read and replayed.
Five regression tests cover these cases; four of them fail on 1.2.1.

## 1.2.1 (2026-10-02)

**Console redesign.** The public console now matches antoine.nutu.net: dark
theme, the retry path first, a live five-step trace, a paper receipt whose
digest you can check and break, a forged-decision demo on the refused path,
and the 11-attack table. Fixes Escape approving a retry after an earlier
approval. No runtime, sample, or proof change.

**Honest wording.** Receipts and grants are described as hash-bound and
tamper-evident, not cryptographic or signed: digests are unkeyed SHA-256.
The README and SECURITY.md now state that "the agent cannot create an
approval" holds for an agent confined to the MCP tools, and that the approval
store must stay outside the agent's filesystem reach. The README opens with
the three-path scenario and a new preview image; the pair walkthrough no
longer calls trimmed output unedited.

**Hardening.** The console pages carry a Content Security Policy (same-origin
scripts, styles, and data only), with the boot fallback moved out of inline
script. CI checkouts no longer persist credentials. The package is marked
private so it cannot be published to npm by accident. `@types/node` tracks
the supported Node 22 runtime, zod is 4.6.5 in both labs, and `npm audit` is
clean.

## 1.2.0 (2026-10-01)

The repository's history was squashed into one commit when it was
republished at 1.2.0; earlier releases are summarized below.

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
