import { SqlClient } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { assert, describe, it } from "@effect/vitest"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { ConfigProvider, Effect, Layer, Redacted } from "effect"
import { afterAll, beforeAll, beforeEach } from "vitest"
import { RepoConnectionRepository } from "../../../connections/domain/ports/repo-connection-repository.ts"
import { UserRepository } from "../../../connections/domain/ports/user-repository.ts"
import { Repository } from "../../../connections/domain/repository.ts"
import { ForgeIdentity } from "../../../connections/domain/user.ts"
import { PgRepoConnectionRepositoryLive } from "../../../connections/infrastructure/persistence/pg-repo-connection-repository.ts"
import { PgUserRepositoryLive } from "../../../connections/infrastructure/persistence/pg-user-repository.ts"
import { MigrationsLive } from "../../../database/index.ts"
import { ProcessNextRun } from "../../application/process-next-run.ts"
import { RequeueInterruptedRuns } from "../../application/requeue-interrupted-runs.ts"
import { makeDayWindow } from "../../domain/day-window.ts"
import { JobQueue } from "../../domain/ports/job-queue.ts"
import { PgJobQueueLive } from "../persistence/pg-job-queue.ts"
import { RunWorkerLive } from "./run-worker.ts"

/**
 * What this test drives: the worker as a *lifecycle*. Everything about what a
 * Run does is tested through the use case; what is left here is the one thing a
 * use case cannot show — that the fiber belongs to the layer's scope, so it
 * starts with the application and stops with it.
 */

let container: StartedPostgreSqlContainer

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start()
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

const pool = () =>
  PgClient.layer({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    username: container.getUsername(),
    password: Redacted.make(container.getPassword())
  })

const database = () => MigrationsLive.pipe(Layer.provideMerge(pool()))

/** A poll interval short enough that the test is not mostly waiting. */
const TestConfig = Layer.setConfigProvider(ConfigProvider.fromMap(new Map([["WORKER_POLL_INTERVAL", "20 millis"]])))

const worker = () =>
  RunWorkerLive.pipe(
    Layer.provide(Layer.mergeAll(ProcessNextRun.Default, RequeueInterruptedRuns.Default)),
    Layer.provide(PgJobQueueLive),
    Layer.provide(TestConfig)
  )

const fixtures = Layer.suspend(() =>
  Layer.mergeAll(PgUserRepositoryLive, PgRepoConnectionRepositoryLive, PgJobQueueLive).pipe(
    Layer.provideMerge(database())
  )
)

beforeEach(async () => {
  await Effect.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`truncate users cascade`).pipe(Effect.provide(database()))
  )
})

const queueARun = (day: string) =>
  Effect.gen(function* () {
    const users = yield* UserRepository
    const connections = yield* RepoConnectionRepository
    const queue = yield* JobQueue

    const user = yield* users.resolve(
      new ForgeIdentity({
        forge: "github",
        forgeUserId: "583231",
        login: "octocat",
        displayName: null,
        avatarUrl: null
      })
    )
    const connection = yield* connections.connect(
      user.id,
      new Repository({ forge: "github", owner: "octocat", name: "ara" }),
      "42"
    )
    const dayWindow = yield* makeDayWindow(day, "Europe/Paris")

    return yield* queue.enqueue({ userId: user.id, connection, dayWindow, trigger: "user" })
  })

const stateOf = (id: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly state: string }>`select state from runs where id = ${id}`
  ).pipe(Effect.map((rows) => rows[0]?.state))

describe("The worker's lifecycle", () => {
  it.live("picks up queued Runs while the application is up, and stops when it comes down", () =>
    Effect.gen(function* () {
      const picked = yield* queueARun("2026-08-22")

      // The worker lives exactly as long as this scope, which is what a launched
      // layer gives it in the real process.
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(worker())
          yield* Effect.repeat(stateOf(picked.id), { until: (state) => state === "succeeded" })
        })
      )

      // Scope closed: the fiber is gone, and nothing is left claiming Runs.
      const ignored = yield* queueARun("2026-08-23")
      yield* Effect.sleep("200 millis")
      assert.strictEqual(yield* stateOf(ignored.id), "queued")

      // And the Run it did take was finished rather than abandoned mid-flight.
      assert.strictEqual(yield* stateOf(picked.id), "succeeded")
    }).pipe(Effect.provide(fixtures))
  )
})
