import { SqlClient } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { assert, describe, it } from "@effect/vitest"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Array as Arr, Deferred, Effect, Layer, Option, Redacted } from "effect"
import { afterAll, beforeAll, beforeEach } from "vitest"
import { RepoConnectionRepository } from "../../../connections/domain/ports/repo-connection-repository.ts"
import { UserRepository } from "../../../connections/domain/ports/user-repository.ts"
import type { RepoConnection } from "../../../connections/domain/repo-connection.ts"
import { Repository } from "../../../connections/domain/repository.ts"
import { ForgeIdentity } from "../../../connections/domain/user.ts"
import { PgRepoConnectionRepositoryLive } from "../../../connections/infrastructure/persistence/pg-repo-connection-repository.ts"
import { PgUserRepositoryLive } from "../../../connections/infrastructure/persistence/pg-user-repository.ts"
import { MigrationsLive } from "../../../database/index.ts"
import { collectDigestOver, emptyRepoActivitySource } from "../../../digests/testing/fake-repo-activity.ts"
import { passableDraftStage } from "../../../drafts/testing/fake-draft-writer.ts"
import { ProcessNextRun } from "../../application/process-next-run.ts"
import { makeDayWindow } from "../../domain/day-window.ts"
import { JobQueue } from "../../domain/ports/job-queue.ts"
import { PgJobQueueLive } from "./pg-job-queue.ts"
import { PgRunRepositoryLive } from "./pg-run-repository.ts"

/**
 * What these tests drive: the claim, against a real Postgres.
 *
 * ADR-0001 puts the queue in Postgres and makes `select ... for update skip
 * locked` load-bearing. An in-memory fake would agree with any implementation,
 * including one that hands the same Run to two workers, so this is the one
 * place where the database itself is the thing under test.
 *
 * The workers here are two *separate connection pools* — as close to two
 * processes as one test can get — and each one drives `ProcessNextRun`
 * directly. Nothing forks the background fiber or waits for a poll interval.
 */

let container: StartedPostgreSqlContainer

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start()
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

/** A pool of its own, so two "workers" really are two clients of the same database. */
const pool = () =>
  PgClient.layer({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    username: container.getUsername(),
    password: Redacted.make(container.getPassword())
  })

const database = () => MigrationsLive.pipe(Layer.provideMerge(pool()))

/** One worker: the queue, the use case, and its own connection pool. */
// The collect stage is real, over a Forge that answers from a fixture: what is
// under test here is the claim, and a Run still has to be able to finish.
const worker = () =>
  ProcessNextRun.Default.pipe(
    Layer.provide(Layer.mergeAll(collectDigestOver(emptyRepoActivitySource), passableDraftStage)),
    Layer.provideMerge(PgJobQueueLive),
    Layer.provideMerge(pool())
  )

/** Suspended, because the container only has an address once `beforeAll` has run. */
const seeding = Layer.suspend(() =>
  Layer.mergeAll(PgUserRepositoryLive, PgRepoConnectionRepositoryLive, PgJobQueueLive, PgRunRepositoryLive).pipe(
    Layer.provideMerge(database())
  )
)

beforeEach(async () => {
  await Effect.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`truncate users cascade`).pipe(Effect.provide(database()))
  )
})

/** A User with one connected repository, made through the adapters that own those rows. */
const connectedRepository = Effect.gen(function* () {
  const users = yield* UserRepository
  const connections = yield* RepoConnectionRepository

  const user = yield* users.resolve(
    new ForgeIdentity({
      forge: "github",
      forgeUserId: "583231",
      login: "octocat",
      displayName: null,
      avatarUrl: null
    })
  )

  return yield* connections.connect(user.id, new Repository({ forge: "github", owner: "octocat", name: "ara" }), "42")
})

/** One queued Run per day, because a User only ever has one Run in flight per day. */
const enqueueDays = (connection: RepoConnection, days: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const queue = yield* JobQueue

    return yield* Effect.forEach(days, (day) =>
      Effect.flatMap(makeDayWindow(day, "Europe/Paris"), (dayWindow) =>
        queue.enqueue({ userId: connection.userId, connection, dayWindow, trigger: "user" })
      )
    )
  })

/** Narrows an index into the Runs just enqueued, so the assertions below cannot pass vacuously. */
const nth = <A>(values: ReadonlyArray<A>, index: number): A => {
  const value = values[index]
  if (value === undefined) return assert.fail(`expected a Run at position ${index}`)
  return value
}

const daysOf = (count: number) => Arr.makeBy(count, (index) => `2026-08-${String(index + 1).padStart(2, "0")}`)

/** Claim and process until the queue is empty, answering with what this worker took. */
const drain = Effect.gen(function* () {
  const processNextRun = yield* ProcessNextRun
  const claimed: Array<string> = []

  let working = true
  while (working) {
    const processed = yield* processNextRun.execute
    if (Option.isNone(processed)) {
      working = false
    } else {
      claimed.push(processed.value.id)
    }
  }

  return claimed
})

describe("Two workers claiming from one queue", () => {
  it.live("never hand the same Run to both", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const connection = yield* connectedRepository
      const queued = yield* enqueueDays(connection, daysOf(30))

      // Both workers are fully built and connected before either starts
      // claiming, so this is a race and not a head start.
      const contexts = yield* Effect.all([Layer.build(worker()), Layer.build(worker())])
      yield* Effect.forEach(contexts, (context) =>
        Effect.provide(
          Effect.flatMap(SqlClient.SqlClient, (client) => client`select 1`),
          context
        )
      )

      const perWorker = yield* Effect.all(
        contexts.map((context) => Effect.provide(drain, context)),
        { concurrency: "unbounded" }
      )

      const claimed = perWorker.flat()

      // Every Run was processed, and no Run was processed twice.
      assert.lengthOf(claimed, queued.length)
      assert.lengthOf(new Set(claimed), queued.length)
      assert.deepStrictEqual([...claimed].sort(), queued.map((run) => run.id).sort())

      // Both workers really were working: this is a claim under contention.
      for (const byOneWorker of perWorker) {
        assert.isAbove(byOneWorker.length, 0)
      }

      // `attempts` counts claims, so one apiece is the same fact seen from the
      // database's side rather than the workers'.
      const rows = yield* sql<{ readonly attempts: number; readonly state: string }>`
        select attempts, state from runs
      `
      assert.deepStrictEqual(
        rows.map((row) => row.attempts),
        rows.map(() => 1)
      )
      assert.deepStrictEqual(
        rows.map((row) => row.state),
        rows.map(() => "succeeded")
      )
    }).pipe(Effect.scoped, Effect.provide(seeding))
  )

  it.live("skips a locked Run rather than waiting behind it", () =>
    Effect.gen(function* () {
      const connection = yield* connectedRepository
      const enqueued = yield* enqueueDays(connection, ["2026-08-01", "2026-08-02"])
      const [first, second] = [nth(enqueued, 0), nth(enqueued, 1)]

      const locked = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      // One worker holds a row lock on the older Run, exactly as it would while
      // claiming it. Without `skip locked` the other worker would block here
      // until this transaction ended, and this test would time out.
      const holder = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`select id from runs where id = ${first.id} for update`
            yield* Deferred.succeed(locked, void 0)
            yield* Deferred.await(release)
          })
        )
      }).pipe(Effect.provide(pool()), Effect.scoped)

      const claimer = Effect.gen(function* () {
        yield* Deferred.await(locked)
        const queue = yield* JobQueue
        const claimed = yield* queue.claim
        yield* Deferred.succeed(release, void 0)
        return claimed
      }).pipe(Effect.provide(PgJobQueueLive.pipe(Layer.provideMerge(pool()))), Effect.scoped)

      const [, claimed] = yield* Effect.all([holder, claimer], { concurrency: "unbounded" })

      if (Option.isNone(claimed)) return assert.fail("expected the second Run to be claimed")
      assert.strictEqual(claimed.value.id, second.id)
    }).pipe(Effect.provide(seeding))
  )
})

describe("Runs a stopped process was holding", () => {
  it.live("go back on the queue at boot, and are claimed again", () =>
    Effect.gen(function* () {
      const queue = yield* JobQueue
      const connection = yield* connectedRepository
      const run = nth(yield* enqueueDays(connection, ["2026-08-01"]), 0)

      // A worker claimed this Run and the process died with it in hand.
      const claimed = yield* queue.claim
      assert.strictEqual(Option.getOrUndefined(claimed)?.state, "collecting")

      // Until the queue is told, nobody will ever look at it again.
      assert.isTrue(Option.isNone(yield* queue.claim))

      assert.strictEqual(yield* queue.requeueInterrupted, 1)

      const again = yield* queue.claim
      assert.strictEqual(Option.getOrUndefined(again)?.id, run.id)
      // Claimed twice, which is why processing has to be idempotent (ADR-0002).
      assert.strictEqual(Option.getOrUndefined(again)?.attempts, 2)
    }).pipe(Effect.provide(seeding))
  )
})
