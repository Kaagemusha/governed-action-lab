# Governed Action Lab

[![CI](https://github.com/Kaagemusha/governed-action-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/Kaagemusha/governed-action-lab/actions/workflows/ci.yml)
![Node 22](https://img.shields.io/badge/node-22-339933?logo=node.js&logoColor=white)
![35/35 eval cases](https://img.shields.io/badge/eval-35%2F35-brightgreen)
![10/10 attacks held](https://img.shields.io/badge/attacks-10%2F10%20held-brightgreen)

An agent's proposed action is not authorization. This is a small, inspectable
reference implementation that keeps *can the tool act*, *does policy allow
it*, *who authorizes it*, and *was it verified* as four separate,
independently checkable questions instead of one model decision.

![Governed Action Lab console: the yellow retry-lane path open for exact human approval](docs/media/console.png)

![Flipping between the green, yellow, and red paths in the live console](docs/media/demo.gif)

**[Open the live console](https://kaagemusha.github.io/governed-action-lab/)** —
no install, three synthetic paths (allow / approval required / refuse), fully
interactive.

## The failure it prevents

An agent can hold a working tool and fresh evidence without holding authority
to use that tool on this target, right now. Collapsing "can" and "may" into
one model judgment call is how an agent talks itself into an action nobody
approved. This repo keeps them apart with a closed action catalog, a
deterministic policy gate, and approvals a model cannot mint for itself.

## What this proves

- **Approval doesn't bypass freshness.** A valid, single-use human grant still
  gets its evidence rechecked against the real clock at execute time — see the
  stale refusal captured live in [`docs/pair-walkthrough.md`](docs/pair-walkthrough.md).
- **Refusal produces a receipt too.** Denied and refused actions are just as
  verifiable as completed ones — same schema, same digest check.
- **35 adversarial cases and 10 named attacks, each mapped to OWASP LLM Top 10
  or MITRE ATLAS, pass against the real code path**, not a mocked one —
  `npm run eval`, `npm run demo:attacks`, and
  [`docs/attack-matrix.md`](docs/attack-matrix.md).

## Quick start

Requires Node.js 22+.

```bash
npm install
npm run check              # typecheck, tests, evals, demo + proof drift, public-safety
npm run action -- demo --json
```

Serve `docs/` with any static file server to run the console locally.

## Two labs, one boundary

```text
Context Layer Lab  ->  diagnose        what current evidence supports
Governed Action Lab ->  prepare/approve what may execute, under whose authority
                    ->  execute/verify  with what receipt
```

[Context Layer Lab](https://kaagemusha.github.io/context-layer-lab/) answers
what the evidence supports. This repo answers what may execute given that
evidence, under whose authority, and with what receipt. They're one pitch in
two repos, not two unrelated projects — the real command sequence between
them, with real output, is in
[`docs/pair-walkthrough.md`](docs/pair-walkthrough.md).

## Scope and limits

**Status: reference implementation, not a production authorization system.**
It demonstrates deterministic policy gates, non-mintable operator approvals,
and cryptographic action receipts as a teaching and portfolio artifact. It
does not provide production identity, RBAC, multi-tenancy, machine isolation,
or a tamper-proof external log, and it has not been hardened against
adversarial misuse. There is no production, network, credential, financial,
or deletion adapter, and there never will be one in this repository — see
[`docs/architecture.md`](docs/architecture.md#threat-model-and-limits) for the
full threat model.

## Learn more

- [`docs/architecture.md`](docs/architecture.md) — diagram, contracts, MCP
  tools, evaluations, threat model, repository map, full CLI reference.
- [`docs/attack-matrix.md`](docs/attack-matrix.md) — all 10 named attacks,
  mapped to OWASP LLM Top 10 / MITRE ATLAS / CWE, with the defended layer and
  test for each.
- [`docs/adr/`](docs/adr/) — 7 architecture decision records: why a closed
  catalog, why single-use approvals, why receipts hash before/after state,
  and more.
- [`docs/pair-walkthrough.md`](docs/pair-walkthrough.md) — the real end-to-end
  command sequence against Context Layer Lab, with real captured output.
- [`docs/operational-proof.md`](docs/operational-proof.md) — what has actually
  run, including a private green action and a portable proof packet.
- [`docs/how-to-adopt.md`](docs/how-to-adopt.md) — how to put this pattern in
  front of a real agent, and the honest list of what production needs that
  this repo doesn't provide.
- [`docs/talk-track.md`](docs/talk-track.md) — the 90-second explanation and
  three questions a skeptic asks.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development checks and how to add an
  attack or eval case.

## License

MIT
