import { SqlClient } from "@effect/sql"
import { Effect, Layer } from "effect"
import { MigrationsTable } from "../../../database/index.ts"
import { DependencyStatus } from "../../domain/health-report.ts"
import { SystemProbe } from "../../domain/ports/system-probe.ts"

const DATABASE = "database"

/** Bounded so a hung connection degrades the report instead of hanging the probe. */
const PROBE_TIMEOUT = "2 seconds"

/**
 * Driven (outbound) adapter backing `SystemProbe` with the running process and
 * the application's Postgres. Reading the migrations table covers all three
 * ways the database can let us down: down, unreachable, or never migrated.
 */
export const RuntimeSystemProbeLive = Layer.effect(
  SystemProbe,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const unreachable = new DependencyStatus({ name: DATABASE, reachable: false })

    const database = sql<{ readonly migration_id: number }>`
      select migration_id from ${sql(MigrationsTable)} limit 1
    `.pipe(
      Effect.map((rows) => new DependencyStatus({ name: DATABASE, reachable: rows.length > 0 })),
      Effect.timeout(PROBE_TIMEOUT),
      Effect.catchAllCause((cause) => Effect.as(Effect.logWarning("Database health probe failed", cause), unreachable))
    )

    return SystemProbe.of({
      uptimeSeconds: Effect.sync(() => Math.round(process.uptime())),
      dependencies: Effect.map(database, (status) => [status])
    })
  })
)
