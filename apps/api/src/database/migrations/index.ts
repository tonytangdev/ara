import type { SqlClient } from "@effect/sql"
import type { Effect } from "effect"
import schemaFoundations from "./0001_schema_foundations.ts"
import usersAndSessions from "./0002_users_and_sessions.ts"

/**
 * Every migration, in order. Keys are `<id>_<name>`; ids must be unique and
 * ascending. Migrations are imported rather than discovered on disk so that the
 * set is identical in `src`, in `dist` and under test.
 */
export const migrations: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>> = {
  "0001_schema_foundations": schemaFoundations,
  "0002_users_and_sessions": usersAndSessions
}
