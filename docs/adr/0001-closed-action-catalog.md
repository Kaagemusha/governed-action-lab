# 1. Closed action catalog, not natural-language classification

## Status

Accepted.

## Context

An agent proposing "retry the failed lane" is a natural-language sentence
before it is anything else. The obvious way to decide whether that sentence
is safe is to ask a model whether it looks dangerous. That approach makes the
model doing the classifying part of the security boundary — the same model
(or a model with the same failure modes) that produced the proposal in the
first place. A sufficiently persuasive or malformed input can move the
classification, and there is no way to audit "the model thought this was
fine" after the fact in a way a reviewer can independently recompute.

## Decision

`ACTION_CATALOG` in `src/catalog.ts` is a small, closed, statically typed set
of three action types: `inspect_run_receipt`, `retry_failed_lane`,
`delete_preserved_output`. Each has a strict Zod schema
(`catalogActionSchema`) that rejects unknown keys and unknown action types
outright. Policy evaluation (`src/policy.ts`) runs entirely on typed fields —
`action.type`, `target.resourceId`, `target.environment` — never on a prose
`intent` string. `intent` exists on the request only as a human-readable
label; nothing in the policy engine reads it.

## Consequences

- Adding a new action requires a schema change and a policy rule, not a
  prompt tweak. That is deliberately slower and more visible than editing a
  classifier prompt.
- An agent cannot propose an action outside the catalog and have it evaluated
  at all — `evaluateAction` throws before reaching policy if no rule matches
  the action type.
- The system cannot classify actions it wasn't built to know about. This is a
  real limitation, not just a safety margin: extending the lab to a new
  domain means writing new schema and policy, not writing a better prompt.
