import { SqlClient } from "@effect/sql"
import { Effect, Layer, Schema } from "effect"
import { RepoConnectionRepository } from "../../domain/ports/repo-connection-repository.ts"
import { RepoConnection, type RepoConnectionId } from "../../domain/repo-connection.ts"
import type { Repository } from "../../domain/repository.ts"
import type { UserId } from "../../domain/user.ts"

interface RepoConnectionRow {
  readonly id: string
  readonly user_id: string
  readonly forge: string
  readonly owner: string
  readonly name: string
  readonly installation_external_id: string
  readonly created_at: Date
}

const decode = Schema.decodeUnknown(RepoConnection)

const toRepoConnection = (row: RepoConnectionRow) =>
  decode({
    id: row.id,
    userId: row.user_id,
    repository: { forge: row.forge, owner: row.owner, name: row.name },
    installationExternalId: row.installation_external_id,
    connectedAt: row.created_at.toISOString()
  })

/**
 * Driven (outbound) adapter for Repo Connections.
 *
 * Every statement carries `user_id` in its `where` clause, including the ones
 * that only read. That is what makes "a User cannot see another User's
 * connection" a property of the SQL rather than a check somebody has to
 * remember: a lookup by id alone is not expressible through this adapter.
 *
 * Rows that cannot be decoded are defects — the schema and this adapter are
 * written together.
 */
export const PgRepoConnectionRepositoryLive = Layer.effect(
  RepoConnectionRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const connect = (userId: UserId, repository: Repository, installationExternalId: string) =>
      sql<RepoConnectionRow>`
        insert into repo_connections (user_id, forge, owner, name, installation_external_id)
        values (${userId}, ${repository.forge}, ${repository.owner}, ${repository.name}, ${installationExternalId})
        on conflict (user_id, forge, owner, name) do update set
          installation_external_id = excluded.installation_external_id
        returning *
      `.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.dieMessage("upsert of a Repo Connection returned no row")
            : toRepoConnection(rows[0])
        ),
        Effect.orDie
      )

    const listFor = (userId: UserId) =>
      sql<RepoConnectionRow>`
        select * from repo_connections where user_id = ${userId} order by created_at
      `.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, toRepoConnection)),
        Effect.orDie
      )

    const findOwnedBy = (id: RepoConnectionId, userId: UserId) =>
      sql<RepoConnectionRow>`
        select * from repo_connections where id = ${id} and user_id = ${userId}
      `.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.succeedNone : Effect.asSome(toRepoConnection(rows[0]))
        ),
        Effect.orDie
      )

    const deleteOwnedBy = (id: RepoConnectionId, userId: UserId) =>
      sql<{ readonly id: string }>`
        delete from repo_connections where id = ${id} and user_id = ${userId} returning id
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie
      )

    return RepoConnectionRepository.of({ connect, listFor, findOwnedBy, deleteOwnedBy })
  })
)
