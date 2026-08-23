import { SqlClient } from "@effect/sql"
import { Effect, Layer } from "effect"
import type { UserId } from "../../../connections/domain/user.ts"
import { RunRepository } from "../../domain/ports/run-repository.ts"
import type { RunId } from "../../domain/run.ts"
import { type RunRow, runColumns, toRun } from "./run-row.ts"

/**
 * Driven (outbound) adapter for reading Runs.
 *
 * Every statement carries `user_id` in its `where` clause, including the ones
 * that only read, so "a User cannot see another User's Run" is a property of
 * the SQL rather than a check somebody has to remember to apply.
 */
export const PgRunRepositoryLive = Layer.effect(
  RunRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = runColumns(sql)

    const findOwnedBy = (id: RunId, userId: UserId) =>
      sql<RunRow>`select ${columns} from runs where id = ${id} and user_id = ${userId}`.pipe(
        Effect.flatMap((rows) => (rows[0] === undefined ? Effect.succeedNone : Effect.asSome(toRun(rows[0])))),
        Effect.orDie
      )

    const listFor = (userId: UserId, limit: number) =>
      sql<RunRow>`
        select ${columns} from runs where user_id = ${userId} order by requested_at desc limit ${limit}
      `.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, toRun)),
        Effect.orDie
      )

    return RunRepository.of({ findOwnedBy, listFor })
  })
)
