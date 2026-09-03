# Pair walkthrough

The real handoff, end to end: [Context Layer Lab](https://kaagemusha.github.io/context-layer-lab/)
answers what current evidence supports, then Governed Action Lab decides what
may execute under that evidence, gets a human decision, executes, and proves
it with a receipt. Every command below is copy-pasteable and every block of
output is a real, unedited run of these two public repos side by side.

```bash
git clone https://github.com/Kaagemusha/context-layer-lab.git
git clone https://github.com/Kaagemusha/governed-action-lab.git
cd context-layer-lab && npm ci && npm run build
cd ../governed-action-lab && npm ci && npm run build
```

## 1. Diagnose the evidence

From `context-layer-lab`:

```bash
npm run diagnose -- --output /tmp/cl-snapshot.json
```

This writes a `context-layer-diagnostic/v2` packet: a scored assessment plus
the typed records it was scored from, each bound to a source and a due
window. `governed-action-lab` will re-derive everything it needs from this
one file; it never imports `context-layer-lab` source.

## 2. Propose the action

From `governed-action-lab`, against that diagnostic:

```bash
node dist/src/cli.js propose \
  --diagnostic /tmp/cl-snapshot.json \
  --action retry_failed_lane \
  --lane site-refresh \
  --output /tmp/action-request.json
```

```json
{
  "schemaVersion": "governed-action-request/v1",
  "id": "request-44bae563c30c5dea",
  "action": { "type": "retry_failed_lane", "laneId": "site-refresh", "recordId": "site-refresh-receipt" },
  "target": { "adapterId": "governed-automation", "resourceId": "site-refresh", "environment": "synthetic_sandbox" },
  "evidence": { "diagnosticFormat": "context-layer-diagnostic/v2", "recordIds": ["site-refresh-receipt"], "asOf": "2026-07-28T09:10:00Z" }
}
```

(Trimmed for length; the CLI's actual output also carries the request's
`retryPayloadHash`, `expectedState.contentHash`, and `idempotencyKey`.)

## 3. Prepare the review

`prepare` takes that existing request, independently re-derives its evidence
binding from the diagnostic, rejects any mismatch, evaluates policy, and
simulates the effect — a strict `governed-action-review/v2` packet plus an
optional human-readable brief:

```bash
node dist/src/cli.js prepare \
  --diagnostic /tmp/cl-snapshot.json \
  --request /tmp/action-request.json \
  --output /tmp/action-review.json \
  --brief-output /tmp/action-review.md
```

`/tmp/action-review.md`:

```
# Governed Action Review
- Status: APPROVAL_REQUIRED
- Action: retry_failed_lane on site-refresh.
- Evidence: 1 record(s) at 2026-07-28T09:10:00Z; digest 3856460b1b54.
- Authority: Exact, expiring human approval is required; the agent cannot approve.
- Next: Review the exact target, effect, evidence, expiry, and rollback contract.
```

`prepare` never approves or executes. It only tells you what would happen and
under what authority.

## 4. Approve

`approve` is a real interactive operator command — it refuses to run without
a TTY, and it will not accept `--yes` or any piped confirmation:

```bash
node dist/src/cli.js approve \
  --request /tmp/action-request.json \
  --decision /tmp/action-decision.json \
  --approval-store /tmp/governed-action-demo/approvals.json \
  --operator reviewer \
  --output /tmp/action-approval.json
```

(`/tmp/action-decision.json` is the `decision` object out of the review
packet from step 3 — extract it with `jq .decision action-review.json` or a
one-line script.)

It prints the exact target, effect, evidence, expiry, and rollback contract,
then blocks:

```
Target: site-refresh
Effect: Create one retry record for site-refresh.
Evidence: site-refresh-receipt
Expiry: 5 minutes
Rollback: exact pre-action sandbox snapshot
Agent cannot approve this action.
Type "APPROVE" to issue the exact single-use grant:
```

Typing the literal `APPROVE` issues a five-minute, single-use grant bound to
both the request digest and the decision digest:

```json
{
  "schemaVersion": "governed-action-approval/v1",
  "id": "approval-f9ad1896-76a0-42ff-ac04-ca1718e6df73",
  "approvedBy": "reviewer",
  "expiresAt": "2026-09-03T00:01:45.459Z",
  "singleUse": true
}
```

## 5. Execute

```bash
node dist/src/cli.js execute \
  --diagnostic /tmp/cl-snapshot.json \
  --request /tmp/action-request.json \
  --decision /tmp/action-decision.json \
  --approval-store /tmp/governed-action-demo/approvals.json \
  --receipt-store /tmp/governed-action-demo/receipts.json \
  --sandbox /tmp/governed-action-demo/sandbox \
  --output /tmp/action-receipt.json
```

`execute` always uses the system clock — there is no `--at` override, on
purpose. Run this sequence today and you will get exactly this receipt,
because the bundled public evidence is pinned to `2026-07-28T09:10:00Z` and
the public policy's evidence window is one day
(`data/policy.json: maxEvidenceAgeSeconds: 86400`):

```json
{
  "schemaVersion": "governed-action-receipt/v2",
  "result": "stale",
  "preconditionCheck": { "passed": false, "detail": "Evidence expired before execution." },
  "effects": [],
  "verification": { "passed": false, "detail": "Execution did not reach verification." }
}
```

This is the system working as designed, not a broken demo. The approval from
step 4 authorized the action; it did not authorize skipping the freshness
check. `execute` independently rechecks evidence age against the real clock
every time, so a stale approval — even a valid, single-use, correctly signed
one — still refuses at the door. That refusal is itself a receipt: no
approval was consumed, no effect ran, and the record below verifies.

## 6. Verify the receipt

```bash
node dist/src/cli.js verify-receipt --receipt /tmp/action-receipt.json
```

```json
{ "valid": true, "detail": "Receipt schema and digest verify." }
```

Verification checks receipt schema and digest, not whether the action
succeeded — a correctly refused action produces just as valid a receipt as a
completed one.

## Seeing a completed (non-stale) receipt

The public fixture's evidence is intentionally frozen for reproducibility, so
the sequence above will not produce `"result": "succeeded"` once real time has
moved past its one-day window. To see that path deterministically, use the
suite that runs the whole lifecycle under a controlled clock instead of the
system clock:

```bash
npm run eval   # 35 adversarial cases, including a green same-day execute
```

See [architecture.md](architecture.md) for the full contract and command
reference, and [operational-proof.md](operational-proof.md) for what has
actually run outside this synthetic sandbox.
