import { SqlClient } from "@effect/sql"
import { DateTime, Effect, Layer } from "effect"
import { JobQueue, type RegenerationRequest, type RunRequest } from "../../domain/ports/job-queue.ts"
import { IN_FLIGHT_STATES, type RunId, type RunOutcome, type RunState } from "../../domain/run.ts"
import type { RunCost } from "../../domain/run-cost.ts"
import { type RunRow, runColumns, toRun } from "./run-row.ts"

/** Where a Run is left when a process stops mid-flight; the states `requeueInterrupted` rescues. */
const ABANDONED_STATES: ReadonlyArray<RunState> = ["collecting", "drafting"]

/**
 * Driven (outbound) adapter for the queue: Postgres, per ADR-0001.
 *
 * The claim is the whole point of this file:
 *
 * ```sql
 * with claimed as (select id from runs where state = 'queued' ... for update skip locked limit 1)
 * update runs set state = 'collecting' ... from claimed where runs.id = claimed.id
 * ```
 *
 * `for update` is what stops two workers reading the same row; `skip locked` is
 * what stops the second worker *waiting* for the first, and instead sends it
 * straight to the next Run. Both live in one statement, so selecting a Run and
 * marking it taken cannot come apart — there is no window in which a Run is
 * chosen but still looks queued.
 *
 * Enqueueing leans on the partial unique index over the in-flight states rather
 * than on a look-then-insert, which would race: two simultaneous requests for
 * the same day both find nothing and both insert. `on conflict do nothing`
 * makes the second one lose, and it is then told about the Run that won.
 */
export const PgJobQueueLive = Layer.effect(
  JobQueue,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = runColumns(sql)
    const runsColumns = runColumns(sql, "runs.")

    const inFlightFor = (request: RunRequest) =>
      sql<RunRow>`
        select ${columns} from runs
        where user_id = ${request.userId}
          and forge = ${request.connection.repository.forge}
          and owner = ${request.connection.repository.owner}
          and name = ${request.connection.repository.name}
          and day = ${request.dayWindow.day}
          and ${sql.in("state", IN_FLIGHT_STATES)}
        limit 1
      `

    const enqueue = (request: RunRequest) =>
      sql<RunRow>`
        insert into runs (
          user_id, repo_connection_id, forge, owner, name,
          day, time_zone, window_starts_at, window_ends_at, trigger
        )
        values (
          ${request.userId},
          ${request.connection.id},
          ${request.connection.repository.forge},
          ${request.connection.repository.owner},
          ${request.connection.repository.name},
          ${request.dayWindow.day},
          ${request.dayWindow.timeZone},
          ${DateTime.toDate(request.dayWindow.startsAt)},
          ${DateTime.toDate(request.dayWindow.endsAt)},
          ${request.trigger}
        )
        on conflict do nothing
        returning ${columns}
      `.pipe(
        // No row back means the index refused the insert: a Run for this day is
        // already in flight, and that Run is the honest answer to the request.
        Effect.flatMap((inserted) => (inserted.length > 0 ? Effect.succeed(inserted) : inFlightFor(request))),
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.dieMessage("enqueueing a Run returned no row") : toRun(rows[0])
        ),
        Effect.orDie
      )

    const regenerationInFlightFor = (request: RegenerationRequest) =>
      sql<RunRow>`
        select ${columns} from runs
        where user_id = ${request.userId}
          and source_digest_id = ${request.digestId}
          and ${sql.in("state", IN_FLIGHT_STATES)}
        limit 1
      `

    /**
     * The new Run is copied out of the one it regenerates rather than described
     * again by the caller, so the repository and the Day Window cannot come
     * adrift from the Digest it writes from. `user_id` in the `where` clause is
     * what makes regenerating somebody else's Run match no row.
     */
    const enqueueRegeneration = (request: RegenerationRequest) =>
      sql<RunRow>`
        insert into runs (
          user_id, repo_connection_id, forge, owner, name,
          day, time_zone, window_starts_at, window_ends_at, trigger, source_digest_id
        )
        select
          user_id, repo_connection_id, forge, owner, name,
          day, time_zone, window_starts_at, window_ends_at, 'user', ${request.digestId}
        from runs
        where id = ${request.sourceRunId} and user_id = ${request.userId}
        on conflict do nothing
        returning ${columns}
      `.pipe(
        // No row back means the index refused it: this User is already having
        // this Digest written again, and that Run is the honest answer.
        Effect.flatMap((inserted) =>
          inserted.length > 0 ? Effect.succeed(inserted) : regenerationInFlightFor(request)
        ),
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.dieMessage("regenerating a Draft returned no Run") : toRun(rows[0])
        ),
        Effect.orDie
      )

    // A Run that already holds a Digest is claimed straight into `drafting`:
    // there is nothing to collect, and a User polling it should be told what is
    // actually happening rather than watching a stage that will not run.
    const claim = sql<RunRow>`
      with claimed as (
        select id from runs
        where state = 'queued'
        order by requested_at
        for update skip locked
        limit 1
      )
      update runs
      set state = case when runs.source_digest_id is null then 'collecting' else 'drafting' end,
          attempts = attempts + 1,
          started_at = now()
      from claimed
      where runs.id = claimed.id
      returning ${runsColumns}
    `.pipe(
      Effect.flatMap((rows) => (rows[0] === undefined ? Effect.succeedNone : Effect.asSome(toRun(rows[0])))),
      Effect.orDie
    )

    const advance = (id: RunId, state: RunState) =>
      Effect.asVoid(sql`update runs set state = ${state} where id = ${id}`).pipe(Effect.orDie)

    // `attempts` is incremented here as well as on the claim, so the column
    // counts what its name says — every attempt at the Run, whether a fresh
    // claim or a retry inside one — and a User reading a failed Run can see how
    // many times Ara tried.
    const recordAttempt = (id: RunId, resumeAt: RunState) =>
      sql<{ readonly attempts: number }>`
        update runs
        set attempts = attempts + 1, state = ${resumeAt}
        where id = ${id}
        returning attempts
      `.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.dieMessage("recording an attempt matched no Run") : Effect.succeed(rows[0])
        ),
        Effect.map((row) => row.attempts),
        Effect.orDie
      )

    const complete = (id: RunId, outcome: RunOutcome) =>
      Effect.asVoid(sql`
        update runs
        set state = ${outcome.state},
            failure_reason = ${outcome.state === "failed" ? outcome.reason : null},
            finished_at = now()
        where id = ${id}
      `).pipe(Effect.orDie)

    const recordCost = (id: RunId, cost: RunCost) =>
      Effect.asVoid(sql`
        update runs
        set input_tokens = ${cost.inputTokens},
            output_tokens = ${cost.outputTokens},
            reasoning_tokens = ${cost.reasoningTokens},
            total_tokens = ${cost.totalTokens},
            cost_usd = ${cost.costUsd}
        where id = ${id}
      `).pipe(Effect.orDie)

    const requeueInterrupted = sql<{ readonly id: string }>`
      update runs
      set state = 'queued', started_at = null
      where ${sql.in("state", ABANDONED_STATES)}
      returning id
    `.pipe(
      Effect.map((rows) => rows.length),
      Effect.orDie
    )

    return JobQueue.of({
      enqueue,
      enqueueRegeneration,
      claim,
      advance,
      recordAttempt,
      complete,
      recordCost,
      requeueInterrupted
    })
  })
)
