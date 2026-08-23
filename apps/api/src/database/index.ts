import { Layer } from "effect"
import { PgLive } from "./client.ts"
import { MigrationsLive } from "./migrator.ts"

/**
 * Postgres, ready to use: the shared connection pool with the schema already
 * migrated. Provide this once at the composition root; everything downstream
 * just asks for `SqlClient`.
 */
export const DatabaseLive = MigrationsLive.pipe(Layer.provideMerge(PgLive))

export { PgLive } from "./client.ts"
export { MigrationsLive, MigrationsTable } from "./migrator.ts"
