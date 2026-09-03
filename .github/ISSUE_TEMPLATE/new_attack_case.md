---
name: New attack case
about: Propose a named attack the deterministic demo/eval suite should defend against
title: "[attack] "
labels: attack-case
---

**Attack name** (short, specific — e.g. `ARGUMENT_SUBSTITUTION`, not "spoofing")

**What it tries to do**

**Which boundary it targets** (schema / policy / approval binding / executor
state recheck / receipt verification — see
[`docs/architecture.md`](../../docs/architecture.md))

**Expected defense**

What structured output should the real code path produce when this is
attempted (a specific `DENIED` / `DETECTED` result, not "it should fail")?

**Is this already covered?**

Checked `evals/action-cases.json` and `npm run demo:attacks` and did not find
an equivalent case: yes / no

See [`CONTRIBUTING.md`](../../CONTRIBUTING.md#adding-a-new-attack-case) for
what a complete case needs before it can be merged.
