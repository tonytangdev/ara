import { PgClient } from "@effect/sql-pg"
import { Effect, Layer } from "effect"
import { DatabaseConfig } from "../config.ts"

/**
 * The application's one Postgres connection pool, published as `SqlClient`.
 * Every adapter that needs SQL receives it from here; nothing builds a pool of
 * its own at a call site.
 */
export const PgLive = Layer.unwrapEffect(Effect.map(DatabaseConfig, (config) => PgClient.layer(config)))
