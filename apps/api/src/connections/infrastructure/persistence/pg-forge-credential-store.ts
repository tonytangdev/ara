import { SqlClient } from "@effect/sql"
import { DateTime, Effect, Layer, Option } from "effect"
import type { Forge } from "../../domain/forge.ts"
import type { ForgeCredential } from "../../domain/forge-credential.ts"
import { ForgeCredentialStore } from "../../domain/ports/forge-credential-store.ts"
import type { UserId } from "../../domain/user.ts"
import { SecretCipher } from "../crypto/secret-cipher.ts"

interface CredentialRow {
  readonly forge: string
  readonly encrypted_access_token: string
  readonly encrypted_refresh_token: string | null
  readonly access_token_expires_at: Date | null
}

/**
 * Driven (outbound) adapter for Forge credentials, encrypting on the way in and
 * decrypting on the way out (ADR-0005). A credential that will not decrypt is a
 * defect, not a missing credential: pretending it is absent would silently sign
 * the person out of their own repositories.
 */
export const PgForgeCredentialStoreLive = Layer.effect(
  ForgeCredentialStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const cipher = yield* SecretCipher

    const save = (userId: UserId, credential: ForgeCredential) =>
      Effect.gen(function* () {
        const accessToken = yield* cipher.encrypt(credential.accessToken)
        const refreshToken = yield* Option.match(credential.refreshToken, {
          onNone: () => Effect.succeed(null),
          onSome: (token) => cipher.encrypt(token)
        })
        const expiresAt = Option.getOrNull(Option.map(credential.accessTokenExpiresAt, DateTime.toDate))

        yield* sql`
          insert into forge_credentials (
            user_id, forge, encrypted_access_token, encrypted_refresh_token, access_token_expires_at
          )
          values (${userId}, ${credential.forge}, ${accessToken}, ${refreshToken}, ${expiresAt})
          on conflict (user_id) do update set
            forge = excluded.forge,
            encrypted_access_token = excluded.encrypted_access_token,
            encrypted_refresh_token = excluded.encrypted_refresh_token,
            access_token_expires_at = excluded.access_token_expires_at
        `
      }).pipe(Effect.asVoid, Effect.orDie)

    const find = (userId: UserId) =>
      Effect.gen(function* () {
        const rows = yield* sql<CredentialRow>`select * from forge_credentials where user_id = ${userId}`
        const row = rows[0]
        if (row === undefined) return Option.none<ForgeCredential>()

        const accessToken = yield* cipher.decrypt(row.encrypted_access_token)
        const refreshToken =
          row.encrypted_refresh_token === null
            ? Option.none()
            : Option.some(yield* cipher.decrypt(row.encrypted_refresh_token))

        return Option.some<ForgeCredential>({
          forge: row.forge as Forge,
          accessToken,
          refreshToken,
          accessTokenExpiresAt: Option.map(Option.fromNullable(row.access_token_expires_at), DateTime.unsafeFromDate)
        })
      }).pipe(Effect.orDie)

    return ForgeCredentialStore.of({ save, find })
  })
)
