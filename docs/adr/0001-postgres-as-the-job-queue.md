# Postgres as the job queue

A Run does slow work (Forge API calls, then a language model call), so it cannot
happen inside an HTTP request. We queue Runs in a Postgres table claimed with
`SELECT ... FOR UPDATE SKIP LOCKED`, behind a `JobQueue` port, rather than adding
Redis and BullMQ.

## Considered Options

Redis + BullMQ was the alternative, and it is the more conventional choice. It
was rejected because we need Postgres regardless (Users, Repo Connections,
Digests, Drafts), so Redis would be a *second* stateful service rather than a
replacement for one. Splitting the queue from the data also means no transaction
spans both: "the job succeeded but the write failed" becomes a state we would
have to reason about, whereas with Postgres a Run is enqueued in the same
transaction as the row that caused it. BullMQ is also Promise-based and
imperative, so in an Effect codebase it would be wrapped, and the wrapper leaks:
untyped errors, no structured concurrency, and shutdown that does not compose
with the Layer scope.

The old objection to database-backed queues — polling storms and lock contention
— predates `FOR UPDATE SKIP LOCKED`, which lets each worker claim a different row
without blocking. At one Run per User per day, Postgres is not the constraint.

## Consequences

The `JobQueue` port keeps this reversible: moving to Redis, BullMQ, or
`@effect/experimental`'s `PersistedQueue` is an adapter swap, not a rewrite. We
do have to implement retry, backoff and dead-lettering ourselves, and we give up
BullMQ's ready-made ops UI.
