import { createHash, randomBytes } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { DateTime, Effect, Layer, Option, Redacted } from "effect"
import { SessionConfig } from "../../../config.ts"
import { SessionStore } from "../../domain/ports/session-store.ts"
import type { UserId } from "../../domain/user.ts"

const TOKEN_BYTES = 32

/**
 * What goes in the column. The browser holds the token; Postgres holds only
 * this, so a dump of `sessions` cannot be replayed against the API.
 */
const digestOf = (token: Redacted.Redacted<string>) =>
  createHash("sha256").update(Redacted.value(token), "utf8").digest("hex")

interface SessionRow {
  readonly user_id: string
  readonly expires_at: Date
}

/**
 * Driven (outbound) adapter for sessions.
 *
 * Expiry is enforced in the query rather than after it, so a stale row is
 * indistinguishable from a missing one at every layer above. Nothing here ever
 * returns a token it did not just generate.
 */
export const PgSessionStoreLive = Layer.effect(
  SessionStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { lifetime } = yield* SessionConfig

    const issue = (userId: UserId) =>
      Effect.gen(function* () {
        const token = Redacted.make(randomBytes(TOKEN_BYTES).toString("base64url"))
        const expiresAt = DateTime.addDuration(yield* DateTime.now, lifetime)

        yield* sql`
          insert into sessions (user_id, token_digest, expires_at)
          values (${userId}, ${digestOf(token)}, ${DateTime.toDate(expiresAt)})
        `

        return { session: { userId, expiresAt }, token }
      }).pipe(Effect.orDie)

    const resolve = (token: Redacted.Redacted<string>) =>
      sql<SessionRow>`
        select user_id, expires_at from sessions
        where token_digest = ${digestOf(token)} and expires_at > now()
      `.pipe(
        Effect.map((rows) =>
          Option.map(Option.fromNullable(rows[0]), (row) => ({
            userId: row.user_id as UserId,
            expiresAt: DateTime.unsafeFromDate(row.expires_at)
          }))
        ),
        Effect.orDie
      )

    const revoke = (token: Redacted.Redacted<string>) =>
      Effect.asVoid(sql`delete from sessions where token_digest = ${digestOf(token)}`).pipe(Effect.orDie)

    return SessionStore.of({ issue, resolve, revoke })
  })
)
