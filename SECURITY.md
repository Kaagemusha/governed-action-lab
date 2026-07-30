# Security

## Scope

Governed Action Lab is a reference implementation with synthetic fixtures and a
temporary-directory executor. It does not provide production authorization or
remote execution.

The security-relevant invariants are:

- unknown actions fail at strict intake;
- red actions have no executor path;
- yellow actions require a separate exact, expiring, single-use approval;
- policy, evidence, target state, and freshness are rechecked before execution;
- MCP cannot create approvals;
- adapters accept typed parameters, never shell command strings;
- tests and demos use synthetic or temporary state only.

## Reporting

Report a suspected vulnerability through GitHub's private vulnerability
reporting feature after publication. Do not include credentials, private
operational data, or exploit details in a public issue.

## Important limitations

Local approval digests detect accidental tampering and bind scope. They are not
a security boundary against a process that controls the same machine. Receipt
digests are integrity checks, not tamper-proof audit logs. The policy engine
does not determine whether external evidence is true.

No production adapter is included. Adding one requires a separate threat model,
authorization design, isolation boundary, and adversarial review.
