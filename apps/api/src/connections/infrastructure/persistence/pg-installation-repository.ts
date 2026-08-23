import { SqlClient } from "@effect/sql"
import { Effect, Layer } from "effect"
import type { Forge } from "../../domain/forge.ts"
import { Installation } from "../../domain/installation.ts"
import { InstallationRepository } from "../../domain/ports/installation-repository.ts"
import type { UserId } from "../../domain/user.ts"

interface InstallationRow {
  readonly forge: string
  readonly external_id: string
  readonly account_login: string
}

const toInstallation = (row: InstallationRow) =>
  new Installation({
    forge: row.forge as Forge,
    externalId: row.external_id,
    accountLogin: row.account_login
  })

/**
 * Driven (outbound) adapter for App installations.
 *
 * An installation is unique per Forge, so re-installing moves it to whoever
 * completed the flow last rather than failing on the constraint.
 */
export const PgInstallationRepositoryLive = Layer.effect(
  InstallationRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const record = (userId: UserId, installation: Installation) =>
      Effect.asVoid(sql`
        insert into forge_installations (user_id, forge, external_id, account_login)
        values (${userId}, ${installation.forge}, ${installation.externalId}, ${installation.accountLogin})
        on conflict (forge, external_id) do update set
          user_id = excluded.user_id,
          account_login = excluded.account_login
      `).pipe(Effect.orDie)

    const listFor = (userId: UserId) =>
      sql<InstallationRow>`
        select forge, external_id, account_login from forge_installations
        where user_id = ${userId}
        order by created_at
      `.pipe(
        Effect.map((rows) => rows.map(toInstallation)),
        Effect.orDie
      )

    return InstallationRepository.of({ record, listFor })
  })
)
