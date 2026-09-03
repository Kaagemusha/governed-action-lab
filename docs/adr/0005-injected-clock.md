# 5. Injected clock, never a bare wall-clock read

## Status

Accepted.

## Context

Freshness, expiry, and staleness are all comparisons against "now." If "now"
means `new Date()` called directly inside policy and executor logic, every
test that needs to exercise a boundary — an approval one second from expiry,
evidence one second past its freshness window — has to either sleep in real
time or become flaky. Worse, production code and test code would be reading
time through different, unaudited paths, so a bug in how "now" is obtained
could hide behind tests that never actually exercised the real boundary.

## Decision

Every function that needs the current time takes a `Clock` (`{ now(): Date }`)
as an explicit parameter, defaulting to `systemClock` (`src/policy.ts`) only
at the outermost call. `evaluateAction`, `executeGovernedAction`,
`validateApproval`, `OperatorApprovalProvider.issue` — all of them take a
clock rather than calling `Date.now()` internally. The attack demo and eval
suite construct explicit clocks (a frozen instant, an instant six minutes
past an approval's expiry, and so on) and get exact, deterministic,
reproducible results with no timing flakiness. Production paths — the CLI,
the MCP server — simply never override the default and always get the real
system clock. There is deliberately no `--at` override on `execute`; see
[`docs/pair-walkthrough.md`](../pair-walkthrough.md) for what that means in
practice when a bundled fixture's evidence ages past its window.

## Consequences

- Every freshness and expiry boundary in the eval suite and attack demo is
  exact and deterministic — no sleeps, no timing-dependent flakiness in CI.
- The same clock abstraction that makes testing precise would let a
  misconfigured host inject a wrong clock into production code; the mitigant
  is that no production code path in this repository ever passes anything
  but the default. A host embedding this library is responsible for not
  doing that.
- `execute` specifically refusing a clock override (unlike `propose`,
  `prepare`, and `evaluate`, which accept `--at` for inspection) is a
  deliberate asymmetry: you can ask "what would this decision look like at
  a given time" for review, but you cannot back-date the moment a mutation
  actually happens.
