# Security

## Defended boundary

Governed Action Lab is a reference implementation with synthetic fixtures and a
temporary-directory executor. Under the trust assumptions below, its defended
boundary is exact typed proposer-to-executor authorization: one strictly parsed
request is bound to one deterministic policy decision, any required operator
approval, the host-supplied verified principal, current evidence and content-hash
state, and one allowlisted adapter invocation.

The executor requires a `verifiedPrincipal` supplied by the embedding host and
compares its exact `kind` and `id` with the request proposer before claiming an
idempotency key, consuming approval, or calling an adapter. The bundled CLI and
MCP server use a fixed synthetic principal. The lab does not authenticate that
principal; a non-synthetic host would have to derive it from its own authenticated
session and keep it out of caller-controlled request fields.

The boundary assumes:

- the Node.js process, code, policy, clock, stores, and injected adapter are trusted;
- the host supplies the verified principal independently of the proposal;
- operator approval is issued through the separate provider and its store is not
  attacker-controlled within the trusted process;
- evidence inputs may be checked for schema, provenance, freshness, and internal
  consistency, but their factual truth is established elsewhere;
- the public synthetic path binds `expectedState.contentHash`; a
  `resourceVersion`-only integration would need its own revalidation logic.

This repository does not provide production authorization, remote execution,
identity authentication, RBAC, isolation, or a production adapter.

## Addressed and tested classes

The deterministic suite exercises these bounded defenses:

- malformed, unknown, command-shaped, extra-field, and out-of-policy proposals
  fail closed at strict schemas or policy;
- one normalized request interpretation and digest is reused at policy, approval,
  and execution boundaries;
- approvals bind every request argument and the complete decision, expire, and
  are single-use; changed arguments and consumed grants do not execute;
- a host-supplied principal mismatch is rejected before state claims, approval
  consumption, or adapter calls;
- execution recomputes policy at the signed `decisionAt`, while current evidence
  age and content-hash target state are independently checked with the execution
  clock;
- red actions have no executor path, runtime adapter identity must match the
  authorized target, and idempotency keys are bound to complete action digests;
- MCP cannot mint approvals, CLI execution rejects inline approval, and an
  evaluated MCP mutation without a separately stored grant reaches no mutating
  adapter;
- the individual receipt verifier detects strict-schema violations and content
  mutation when the stored digest is not recomputed.

Prompt-injection coverage is partial. If injected text causes a proposal to use an
unknown shape, command field, disallowed target, or action outside policy, the gate
rejects it. The lab does not evaluate proposer reasoning or recognize malicious
intent inside an otherwise authorized typed call.

## Receipt integrity boundary

Receipt digests provide integrity for one presented receipt. They are not
signatures, authenticity proofs, or a tamper-proof audit log. Although the schema
contains `previousReceiptId`, the current executor does not build an enforced
chain and there is no collection anchor or chain verifier. Deleting a whole
receipt, inserting another independently valid receipt, reordering receipts, or
duplicating a valid receipt is therefore not detectable by `verifyReceipt`.

Local approval digests likewise detect content changes and bind scope; they are
not a boundary against a process that controls the same machine and can rewrite
data and code.

## Explicit non-goals

The lab does not defend:

- proposer reasoning or intent classification;
- composition or exfiltration across individually authorized calls;
- multi-hop delegation or transitive authority;
- budgets, quotas, or rate limits;
- host, runtime, adapter, policy, clock, or store compromise;
- false but well-formed external evidence;
- production identity, authorization, networking, credentials, account changes,
  communications, finance, deployment, deletion, or other external effects.

The expected-non-defense tests make the composition and receipt-collection limits
executable without adding a production adapter or network access.

## Provenance recording is not enforcement

Execution receipts carry a runtime-assigned `actionId` and, only when the
trusted runtime has direct structural knowledge of it, an optional
`parentActionId`. These fields let an operator reconstruct which governed
action led to another governed action. They are evidentiary, not preventive:
the gate does not verify that child authority was derived from or bounded by a
parent grant, and a `parentActionId` is not evidence that any such bound
existed. The composition non-goal above remains open; this records attribution
without claiming enforced delegation.

## Assurance limits

Passing tests establish deterministic correctness for the inputs and trust
boundaries the suite actually exercises. They do not establish production
hardening, formal verification, comprehensive adversarial robustness, or safety
for an adapter added later. A non-synthetic adapter requires a separate threat
model, authorization design, isolation boundary, and adversarial review.

## Reporting

Report a suspected vulnerability through GitHub's private vulnerability
reporting feature after publication. Do not include credentials, private
operational data, or exploit details in a public issue.
