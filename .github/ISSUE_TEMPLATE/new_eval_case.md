---
name: New eval case
about: Propose a new deterministic case for the npm run eval suite
title: "[eval] "
labels: eval-case
---

**Scenario** (one sentence: the specific input/state combination being tested)

**Which layer it exercises** (context adapter / policy / approval / executor /
idempotency / receipt verification — see
[`docs/architecture.md`](../../docs/architecture.md#evaluations))

**Expected structured output**

```json
{}
```

**Why the current 35 cases don't already cover this**

See [`CONTRIBUTING.md`](../../CONTRIBUTING.md#adding-a-new-eval-case) — the
case must run against the real code path with an explicit expected output, not
a mock.
