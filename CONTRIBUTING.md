# Contributing

This is a small, deliberately bounded reference implementation. Contributions
that stay inside its scope are welcome; contributions that grow it into a
production authorization system are not — see
[`docs/architecture.md`](docs/architecture.md#threat-model-and-limits) for
what it explicitly does not do.

## Development checks

```bash
npm install
npm run typecheck
npm test
npm run eval
npm run demo:check
npm run qa:responsive
npm run public-safety:check
npm run check      # everything above, plus contract and proof drift
```

`npm run check` must be green before any PR is merged. It is network-independent
after `npm install`.

Before pushing, install the fail-closed public-safety hook once:

```bash
git config publicSafety.patternsFile /path/to/private-patterns
npm run public-safety:install
```

## Adding a new attack case

The named attacks in `npm run demo:attacks` (currently 10, see
[`docs/attack-matrix.md`](docs/attack-matrix.md)) live alongside the
deterministic eval suite in `evals/`. A new attack case needs:

1. A concrete, named failure mode (not a vague "could this be abused" note) —
   see the existing cases in `evals/action-cases.json` for the expected shape.
2. An explicit expected structured output, checked against the real schema,
   policy, approval, executor, or receipt-verification code — never a mock.
3. A one-line addition to the coverage list in
   [`docs/architecture.md`](docs/architecture.md#evaluations).

## Adding a new eval case

Eval cases in `evals/action-cases.json` follow the same rule: real code path,
explicit expected output, no mocks. Run `npm run eval` locally before opening
a PR; it must report all cases passing.

## Rules

- Do not hand-edit generated files (`docs/runtime.js`, `docs/sample-data.js`,
  `docs/governed-action-proof.json`). Regenerate with `npm run demo:sync` /
  `npm run proof:sync`, then verify with the matching `*:check` script.
- Never add a production, network, credential, financial, or deletion adapter.
- Never claim formal verification or tamper-proof logging beyond what the
  tests actually demonstrate.
- Run `npm run public-safety:check` before every commit, and full `npm run check`
  before any change that touches `docs/` or publishes anything.
