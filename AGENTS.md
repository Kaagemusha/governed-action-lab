# Repository guidance

Governed Action Lab is a public, synthetic reference implementation. Preserve its
narrow governance architecture and do not connect it to a real system.

## Setup and checks

```bash
npm ci
npm run typecheck
npm test
npm run eval
npm run demo:attacks
npm run check
```

Use `npm run fixture:fresh -- --output <temporary-path>` only for the wall-clock
CLI walkthrough. Deterministic tests and the attack demo use frozen clocks.

## Architecture boundaries

- `src/contracts.ts` is the schema authority. Parse untrusted values with its
  strict Zod schemas before hashing or making authorization decisions.
- `src/context-adapter.ts` binds diagnostic evidence to typed requests.
- `src/policy.ts` classifies requests deterministically; never add model-based or
  natural-language policy classification.
- `src/approval.ts` owns separately issued, exact, expiring, single-use grants.
- `src/executor.ts` is the final shared gate. Preserve its signed-`decisionAt`
  recomputation and independent execution-clock evidence/state checks.
- The host must supply `verifiedPrincipal`; do not derive it from tool input.
- `src/adapters/synthetic-automation.ts` is the only mutating adapter and writes
  only to caller-supplied temporary/sandbox state.
- `verifyReceipt` verifies one receipt, not a receipt collection or chain.

The CLI, MCP handlers, and browser demo are the supported public surfaces.
Dependency-injected adapters and core functions are trusted integration internals,
not remote authorization endpoints.

## Generated files and drift

- Do not hand-edit `docs/runtime.js` or `docs/sample-data.js`; use
  `npm run demo:sync`, then require `npm run demo:check` to pass.
- Do not hand-edit `docs/governed-action-proof.json`; use `npm run proof:sync`,
  then require `npm run proof:check` to pass.
- Context fixtures and metadata are frozen cross-repository contract artifacts.
  Do not refresh hashes or producer commits casually; `npm run contract:check`
  must pass.

## Public-safety constraints

- Keep fixtures synthetic and public-safe. Never add credentials, personal data,
  private paths, hostnames, emails, operational identifiers, or runtime artifacts.
- Do not add network, repository, deployment, communication, credential,
  financial, account, deletion, or other production adapters.
- Do not claim formal verification, production hardening, tamper-proof logging,
  identity authentication, or defenses beyond passing tests.
- Run `npm run public-safety:check` before committing and the full `npm run check`
  before publication.
