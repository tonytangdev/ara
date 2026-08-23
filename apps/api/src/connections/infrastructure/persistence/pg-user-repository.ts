import { SqlClient } from "@effect/sql"
import { Effect, Layer, Schema } from "effect"
import { UserRepository } from "../../domain/ports/user-repository.ts"
import type { TimeZone } from "../../domain/time-zone.ts"
import { type ForgeIdentity, User, type UserId } from "../../domain/user.ts"

interface UserRow {
  readonly id: string
  readonly forge: string
  readonly forge_user_id: string
  readonly login: string
  readonly display_name: string | null
  readonly avatar_url: string | null
  readonly time_zone: string
}

const decode = Schema.decodeUnknown(User)

const toUser = (row: UserRow) =>
  decode({
    id: row.id,
    forge: row.forge,
    forgeUserId: row.forge_user_id,
    login: row.login,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    timeZone: row.time_zone
  })

/**
 * Driven (outbound) adapter for Users.
 *
 * `resolve` is one upsert on `(forge, forge_user_id)`: first sign-in inserts,
 * every later one updates the profile and returns the same row, so two
 * simultaneous sign-ins cannot produce two Users. Rows that cannot be decoded
 * are defects — the schema and this adapter are written together.
 */
export const PgUserRepositoryLive = Layer.effect(
  UserRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const resolve = (identity: ForgeIdentity) =>
      sql<UserRow>`
        insert into users (forge, forge_user_id, login, display_name, avatar_url)
        values (
          ${identity.forge}, ${identity.forgeUserId}, ${identity.login},
          ${identity.displayName}, ${identity.avatarUrl}
        )
        on conflict (forge, forge_user_id) do update set
          login = excluded.login,
          display_name = excluded.display_name,
          avatar_url = excluded.avatar_url
        returning *
      `.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.dieMessage("upsert of a User returned no row") : toUser(rows[0])
        ),
        Effect.orDie
      )

    const findById = (id: UserId) =>
      sql<UserRow>`select * from users where id = ${id}`.pipe(
        Effect.flatMap((rows) => (rows[0] === undefined ? Effect.succeedNone : Effect.asSome(toUser(rows[0])))),
        Effect.orDie
      )

    const setTimeZone = (id: UserId, timeZone: TimeZone) =>
      sql<UserRow>`update users set time_zone = ${timeZone} where id = ${id} returning *`.pipe(
        Effect.flatMap((rows) => (rows[0] === undefined ? Effect.succeedNone : Effect.asSome(toUser(rows[0])))),
        Effect.orDie
      )

    return UserRepository.of({ resolve, findById, setTimeZone })
  })
)
