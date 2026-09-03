# Attack matrix

`npm run demo:attacks` runs 10 named attacks against the real schema, policy,
approval, executor, state-recheck, and receipt-verification code — never a
mock. Each row below is one function in
[`src/attack-demo.ts`](../src/attack-demo.ts), mapped to the closest public
taxonomy entry. Sources: [OWASP Top 10 for LLM Applications
2025](https://genai.owasp.org/resource/owasp-top-10-for-llm-applications-2025/),
[MITRE ATLAS](https://atlas.mitre.org/), and [MITRE
CWE](https://cwe.mitre.org/). A taxonomy entry here names the weakness class
the attack would exploit if this layer did not exist — not a claim that the
named framework certifies this repository.

| Attack | Taxonomy | Defended layer | Test |
|---|---|---|---|
| `ARGUMENT_SUBSTITUTION` | OWASP LLM06:2025 Excessive Agency · [CWE-345](https://cwe.mitre.org/data/definitions/345.html) Insufficient Verification of Data Authenticity | An approval binds the full canonical digest of the action request. Swapping `retryPayloadHash` after approval changes the digest, so the stored grant no longer matches. | `argumentSubstitution()` |
| `APPROVAL_REPLAY` | OWASP LLM06:2025 Excessive Agency · [CWE-294](https://cwe.mitre.org/data/definitions/294.html) Authentication Bypass by Capture-replay | Approvals are single-use. `consume()` writes an atomic, exclusive marker before the second execution can proceed, so a successful grant cannot be replayed. | `approvalReplay()` |
| `CONFUSED_DEPUTY` | OWASP LLM06:2025 Excessive Agency · MITRE ATLAS [AML.T0053](https://atlas.mitre.org/techniques/AML.T0053) AI Agent Tool Invocation · [CWE-441](https://cwe.mitre.org/data/definitions/441.html) Confused Deputy | The executor requires an exact match between the host-verified principal and the request's declared proposer before it will act, so one agent's approval cannot execute another agent's request. | `confusedDeputy()` |
| `TOCTOU_CHANGED_STATE` | [CWE-367](https://cwe.mitre.org/data/definitions/367.html) Time-of-check Time-of-use Race Condition | Current target state is reloaded and rehashed immediately before mutation; a hash mismatch against the request's `expectedState` refuses the action as stale. | `changedState()` |
| `RECEIPT_CONTENT_TAMPERING` | [CWE-345](https://cwe.mitre.org/data/definitions/345.html) Insufficient Verification of Data Authenticity | Receipts carry a digest over their own content. Changing `result` after the fact without recomputing the digest is detected on verification. | `receiptTampering()` |
| `EXPIRED_APPROVAL_REUSE` | [CWE-613](https://cwe.mitre.org/data/definitions/613.html) Insufficient Session Expiration | Every approval carries a hard `expiresAt` (five minutes, policy-capped). Validation checks the real clock against it independently of whether the grant is otherwise intact and unconsumed. | `expiredApprovalReuse()` |
| `CANONICALIZATION_BYPASS` | OWASP LLM01:2025 Prompt Injection (argument-injection variant) · [CWE-289](https://cwe.mitre.org/data/definitions/289.html) Authentication Bypass by Alternate Name · [CWE-706](https://cwe.mitre.org/data/definitions/706.html) Use of Incorrectly-Resolved Name or Reference | Lane lookup is exact-string, byte-for-byte, with no Unicode normalization or fuzzy matching. A homoglyph lane ID (Cyrillic "ѕ" standing in for Latin "s") is rejected as absent, not silently coerced to the real lane. | `canonicalizationBypass()` |
| `APPROVAL_SCOPE_WIDENING` | OWASP LLM06:2025 Excessive Agency · [CWE-345](https://cwe.mitre.org/data/definitions/345.html) Insufficient Verification of Data Authenticity | The approval store is keyed by the exact `(actionDigest, decisionDigest)` pair. Retargeting an already-approved request at different evidence (same lane, different underlying record) produces a request the stored grant does not cover. | `approvalScopeWidening()` |
| `POLICY_MANIFEST_TAMPERING` | OWASP LLM03:2025 Supply Chain · [CWE-345](https://cwe.mitre.org/data/definitions/345.html) Insufficient Verification of Data Authenticity | A dependency-injected host policy must carry a trust binding whose digest matches the policy manifest actually in effect. Executing against a policy that was edited after the trust binding was minted invalidates the binding and the action refuses. | `policyManifestTampering()` |
| `IDEMPOTENCY_KEY_COLLISION` | [CWE-694](https://cwe.mitre.org/data/definitions/694.html) Use of Multiple Resources with Duplicate Identifier | An idempotency key is atomically and permanently bound to one action's full digest on first use. Presenting the same key for a structurally different action reports a conflict instead of executing or silently returning the wrong receipt. | `idempotencyKeyCollision()` |

## Coverage note

These 10 cover parameter tampering, replay, principal confusion, race
conditions, output tampering, session expiry, identifier-canonicalization
bypass, scope widening, config/policy supply-chain tampering, and resource-key
collision. They do not cover: denial of service, model-level prompt injection
(there is no model in the decision path to inject into), or attacks on a
production adapter (none exists in this repository — see
[`docs/architecture.md`](architecture.md#threat-model-and-limits)). Propose a
new case via the "new attack case" issue template if you find a gap.

## Reproduce

```bash
npm run demo:attacks
```

```text
ARGUMENT_SUBSTITUTION: DENIED
APPROVAL_REPLAY: DENIED
CONFUSED_DEPUTY: DENIED
TOCTOU_CHANGED_STATE: DENIED
RECEIPT_CONTENT_TAMPERING: DETECTED
EXPIRED_APPROVAL_REUSE: DENIED
CANONICALIZATION_BYPASS: DENIED
APPROVAL_SCOPE_WIDENING: DENIED
POLICY_MANIFEST_TAMPERING: DENIED
IDEMPOTENCY_KEY_COLLISION: DENIED
10/10 expected defenses held
```

The demo uses a frozen synthetic clock and temporary local state. Each case
runs against the real code path with an isolated store and adapter instance;
none of them mutate one another's state.
