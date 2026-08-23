import { SqlClient } from "@effect/sql"
import { DateTime, Effect, Layer } from "effect"
import { JobQueue, type RunRequest } from "../../domain/ports/job-queue.ts"
import { IN_FLIGHT_STATES, type RunId, type RunOutcome, type RunState } from "../../domain/run.ts"
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

    const claim = sql<RunRow>`
      with claimed as (
        select id from runs
        where state = 'queued'
        order by requested_at
        for update skip locked
        limit 1
      )
      update runs
      set state = 'collecting', attempts = attempts + 1, started_at = now()
      from claimed
      where runs.id = claimed.id
      returning ${runsColumns}
    `.pipe(
      Effect.flatMap((rows) => (rows[0] === undefined ? Effect.succeedNone : Effect.asSome(toRun(rows[0])))),
      Effect.orDie
    )

    const advance = (id: RunId, state: RunState) =>
      Effect.asVoid(sql`update runs set state = ${state} where id = ${id}`).pipe(Effect.orDie)

    const complete = (id: RunId, outcome: RunOutcome) =>
      Effect.asVoid(sql`
        update runs
        set state = ${outcome.state},
            failure_reason = ${outcome.state === "failed" ? outcome.reason : null},
            finished_at = now()
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

    return JobQueue.of({ enqueue, claim, advance, complete, requeueInterrupted })
  })
)
