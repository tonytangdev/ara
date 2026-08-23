import { Migrator } from "@effect/sql"
import { Effect, Layer } from "effect"
import { migrations } from "./migrations/index.ts"

/**
 * Where applied migrations are recorded. The health probe reads this table to
 * tell "Postgres is up" apart from "Postgres is up but has never been
 * migrated".
 */
export const MigrationsTable = "schema_migrations"

const applyMigrations = Migrator.make({})({
  loader: Migrator.fromRecord(migrations),
  table: MigrationsTable
}).pipe(
  Effect.tap((applied) =>
    applied.length === 0
      ? Effect.logInfo("Database schema is up to date")
      : Effect.logInfo(
          `Applied ${applied.length} migration(s): ${applied.map(([id, name]) => `${id}_${name}`).join(", ")}`
        )
  ),
  Effect.tapErrorCause((cause) => Effect.logError("Database migrations failed; refusing to start", cause))
)

/**
 * Applying the outstanding migrations is a layer, so it happens while the
 * application is being built — before the HTTP server binds — and a failure
 * takes the whole launch down instead of surfacing as a query error later.
 */
export const MigrationsLive = Layer.effectDiscard(applyMigrations)
