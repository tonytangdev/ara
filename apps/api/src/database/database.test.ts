import { HttpApi, HttpApiBuilder, HttpApiClient } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { SqlClient } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { assert, describe, it } from "@effect/vitest"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Effect, Layer, Redacted } from "effect"
import { afterAll, beforeAll } from "vitest"
import { HealthApiGroup } from "../health/api.ts"
import { HealthLive } from "../health/index.ts"
import { MigrationsLive, MigrationsTable } from "./index.ts"
import { migrations } from "./migrations/index.ts"

/**
 * What these tests drive: the health module over a real Postgres. Scoped to one
 * module on purpose — a database that is up or down is not the other modules'
 * story to tell, and they would drag their own configuration in with them.
 */
const HealthOnlyApi = HttpApi.make("ara").add(HealthApiGroup)

/**
 * Testcontainers gives every run its own Postgres, so `pnpm test` never depends
 * on Compose being up — only on a Docker daemon.
 */
let container: StartedPostgreSqlContainer

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start()
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

const disposablePg = () =>
  PgClient.layer({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    username: container.getUsername(),
    password: Redacted.make(container.getPassword())
  })

const serverOver = <E>(database: Layer.Layer<SqlClient.SqlClient, E>) =>
  HttpApiBuilder.serve().pipe(
    Layer.provide(HttpApiBuilder.api(HealthOnlyApi).pipe(Layer.provide(HealthLive))),
    Layer.provide(database),
    Layer.provideMerge(NodeHttpServer.layerTest)
  )

describe("Postgres", () => {
  it.effect("applies outstanding migrations on startup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const applied = yield* sql<{ readonly name: string }>`
        select name from ${sql(MigrationsTable)} order by migration_id
      `
      assert.deepStrictEqual(
        applied.map((row) => row.name),
        ["schema_foundations", "users_and_sessions", "repo_connections", "runs", "digests", "drafts", "draft_edits"]
      )

      const functions = yield* sql`select proname from pg_proc where proname = 'set_updated_at'`
      assert.lengthOf(functions, 1)
    }).pipe(Effect.provide(MigrationsLive.pipe(Layer.provideMerge(disposablePg()))))
  )

  it.effect("is idempotent when the schema is already up to date", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const applied = yield* sql`select name from ${sql(MigrationsTable)}`
      // One row per migration and no more: booting again applied nothing.
      assert.lengthOf(applied, Object.keys(migrations).length)
    }).pipe(Effect.provide(MigrationsLive.pipe(Layer.provideMerge(disposablePg()))))
  )

  it.effect("is reported as a healthy dependency once migrated", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(HealthOnlyApi)
      const response = yield* client.health.check()
      assert.strictEqual(response.status, "healthy")
      assert.deepStrictEqual(response.dependencies, [{ name: "database", reachable: true }])
    }).pipe(Effect.provide(serverOver(MigrationsLive.pipe(Layer.provideMerge(disposablePg())))))
  )
})

/**
 * The ticket's own verification, automated: boot against a live Postgres, take
 * it away, and watch the health report change without the process falling over.
 */
describe("Postgres going down", () => {
  let victim: StartedPostgreSqlContainer

  beforeAll(async () => {
    victim = await new PostgreSqlContainer("postgres:17-alpine").start()
  }, 180_000)

  afterAll(async () => {
    await victim?.stop().catch(() => {})
  })

  const victimDatabase = Layer.suspend(() =>
    MigrationsLive.pipe(
      Layer.provideMerge(
        PgClient.layer({
          host: victim.getHost(),
          port: victim.getPort(),
          database: victim.getDatabase(),
          username: victim.getUsername(),
          password: Redacted.make(victim.getPassword())
        })
      )
    )
  )

  it.effect("turns the health report unhealthy when the database disappears", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(HealthOnlyApi)

      const healthy = yield* client.health.check()
      assert.strictEqual(healthy.status, "healthy")

      yield* Effect.promise(() => victim.stop())

      const error = yield* Effect.flip(client.health.check())
      if (error._tag !== "Unhealthy") return assert.fail(`expected Unhealthy, got ${error._tag}`)
      assert.strictEqual(error.report.status, "degraded")
      assert.deepStrictEqual(error.report.dependencies, [{ name: "database", reachable: false }])
    }).pipe(Effect.provide(serverOver(victimDatabase)))
  )
})
