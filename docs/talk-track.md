# Talk track

A 90-second verbal explanation of this repository, and the three questions a
technical skeptic actually asks. Draft — adjust to your own voice before
relying on it in a real conversation.

## The 90 seconds

"An agent having access to a tool, and current evidence that an action is
needed, doesn't mean it has permission to take that action. Most agent
frameworks collapse those into one model decision — the same model that
proposed the action also judges whether it's safe. I built a small reference
system that keeps them apart: a closed catalog of what actions exist, a
deterministic policy gate that decides green, yellow, or red, a human
approval step the agent cannot mint for itself, and a receipt that hashes the
before-and-after state so you can check what actually happened, not just
what the system claims happened.

The interesting part isn't the happy path — it's that a valid, correctly
issued human approval still gets its evidence rechecked against the real
clock at execution time. If too much time passes between approval and
execution, it refuses, even though a human already said yes. That's the
whole thesis in one behavior: approval isn't a bypass, it's one gate among
several, and I have a companion repo, Context Layer Lab, that answers the
evidence question this one assumes — is the evidence this decision is based
on actually still current."

## Three questions a skeptic asks

**"Isn't this just a bunch of if-statements? What's actually hard here?"**

Correct, and that's the point — the policy gate is deliberately boring,
typed, closed-catalog logic instead of a model judgment call. The hard part
is everywhere else: binding an approval to the exact request and exact
policy decision it was shown for (not the action type, not a resource name),
making that binding survive a policy change, making a receipt's digest catch
tampering after the fact, and making the freshness check unconditional even
after a human has already approved. None of that is hard to implement in
isolation. It's easy to get subtly wrong, which is why there are 35
deterministic eval cases and 10 named attack simulations, each run against
the real code path, not a mock.

**"This is all synthetic. What happens against something real?"**

Nothing in this public repo touches anything real, on purpose — see
[`docs/architecture.md`](architecture.md#threat-model-and-limits) and
[ADR 4](adr/0004-no-production-adapter.md). The honest answer is in
[`docs/how-to-adopt.md`](how-to-adopt.md): the policy and approval layer
transfers, but a real adapter, real identity behind "who approved this," and
external audit anchoring are all separate, non-optional engineering work
this repo doesn't do for you. I'd rather say that directly than imply a
30-file TypeScript lab is production-ready.

**"Why not just use [framework]'s built-in guardrails / human-in-the-loop
feature?"**

Most of those either classify risk with a model call, or gate on a broad
capability ("can approve mutations") rather than the exact action instance.
The design bet here is narrower and more mechanical on purpose: every gate
is a digest comparison or a typed field check, which means it's something a
reviewer can recompute by hand, not something you have to trust because a
model said so. Whether that trade-off is right for a given system depends on
how much you can afford to make the catalog closed and the policy
deterministic — for a narrow, well-understood action space, I think it's the
right default; for something genuinely open-ended, it isn't, and I'd say so.
