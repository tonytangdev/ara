import { Effect } from "effect"
import type { Installation } from "../domain/installation.ts"
import { type ForgeAuthorizationFailed, GithubAuthorization } from "../domain/ports/github-authorization.ts"
import { InstallationRepository } from "../domain/ports/installation-repository.ts"
import type { User } from "../domain/user.ts"

/**
 * Driving (inbound) port: the person came back from GitHub's installation
 * screen. Ara asks GitHub what was installed rather than trusting the query
 * string, then remembers it against the signed-in User.
 */
export class RecordGithubInstallation extends Effect.Service<RecordGithubInstallation>()(
  "application/connections/RecordGithubInstallation",
  {
    effect: Effect.gen(function* () {
      const github = yield* GithubAuthorization
      const installations = yield* InstallationRepository

      const execute = (user: User, externalId: string): Effect.Effect<Installation, ForgeAuthorizationFailed> =>
        Effect.gen(function* () {
          const installation = yield* github.describeInstallation(externalId)
          yield* installations.record(user.id, installation)
          yield* Effect.logInfo("Recorded App installation").pipe(
            Effect.annotateLogs({ userId: user.id, forge: installation.forge, installation: installation.externalId })
          )
          return installation
        })

      return { execute } as const
    })
  }
) {}
