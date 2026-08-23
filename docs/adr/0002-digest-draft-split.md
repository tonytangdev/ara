# A Digest is built and persisted before a Draft is written

Producing a build-in-public post is two steps, not one: collecting a **Digest**
(deterministic, no language model) and writing a **Draft** from it (a language
model call). We persist the Digest between them rather than piping Forge data
straight into a prompt.

This makes the deterministic half unit-testable with no model in the loop, makes
regenerating a Draft cost one model call and zero Forge calls, gives a Run a
natural idempotency boundary for crash recovery, and separates "the Forge is
rate-limiting us" from "the model is overloaded" into failures that retry
differently.

## Consequences

The split was validated before it was built — see ADR-0004 and the `prototype/`
`digest-split` branch. Blind comparison over 8 real repo-days found the Digest
input produced the better post on 7 of 7 judged days, beating raw Forge payload.
So the split is not a tax paid for testability; it improves the output.
