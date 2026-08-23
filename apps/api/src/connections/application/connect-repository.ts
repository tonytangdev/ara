import { Effect, Option } from "effect"
import { InstallationRepository } from "../domain/ports/installation-repository.ts"
import { ReachableRepositories } from "../domain/ports/reachable-repositories.ts"
import { RepoConnectionRepository } from "../domain/ports/repo-connection-repository.ts"
import { type RepoConnection, RepositoryNotReachable } from "../domain/repo-connection.ts"
import { type Repository, sameRepository } from "../domain/repository.ts"
import type { User } from "../domain/user.ts"

/**
 * Driving (inbound) port: connect a repository.
 *
 * The request is checked against what the User's installations can actually
 * reach before anything is written, so a Repo Connection always means Ara can
 * read that repository today — not that someone once typed its name. A
 * repository that cannot be reached is refused with a reason that says what to
 * do about it, since the fix (install the App on it) is on GitHub's side and
 * the User is the only one who can perform it.
 *
 * The Forge's own spelling of the repository is what gets stored, so the same
 * repository asked for as `Octocat/Hello-World` and `octocat/hello-world` is
 * one connection rather than two.
 */
export class ConnectRepository extends Effect.Service<ConnectRepository>()(
  "application/connections/ConnectRepository",
  {
    effect: Effect.gen(function* () {
      const installations = yield* InstallationRepository
      const reachable = yield* ReachableRepositories
      const connections = yield* RepoConnectionRepository

      const notReachable = (requested: Repository, hasInstallation: boolean) =>
        new RepositoryNotReachable({
          reason: hasInstallation
            ? `Ara's ${requested.forge} App installation cannot reach ${requested.owner}/${requested.name}. ` +
              "Add the repository to the installation, then connect it again."
            : `Ara is not installed on ${requested.forge} for this account. ` +
              "Install the App on the repository first, then connect it."
        })

      const execute = (user: User, requested: Repository): Effect.Effect<RepoConnection, RepositoryNotReachable> =>
        Effect.gen(function* () {
          const installed = (yield* installations.listFor(user.id)).filter(
            (installation) => installation.forge === requested.forge
          )

          const candidates = yield* Effect.forEach(installed, reachable.listFor).pipe(
            Effect.map((perInstallation) => perInstallation.flat()),
            // A Forge that will not answer is indistinguishable, from here, from
            // one that cannot reach the repository: either way Ara cannot read it.
            Effect.catchTag("ForgeAuthorizationFailed", (failure) =>
              Effect.fail(new RepositoryNotReachable({ reason: failure.reason }))
            )
          )

          const match = Option.fromNullable(
            candidates.find((candidate) => sameRepository(candidate.repository, requested))
          )

          const found = yield* Option.match(match, {
            onNone: () => Effect.fail(notReachable(requested, installed.length > 0)),
            onSome: Effect.succeed
          })

          const connection = yield* connections.connect(user.id, found.repository, found.installationExternalId)

          yield* Effect.logInfo("Connected a repository").pipe(
            Effect.annotateLogs({
              userId: user.id,
              connectionId: connection.id,
              forge: found.repository.forge,
              repository: `${found.repository.owner}/${found.repository.name}`
            })
          )

          return connection
        })

      return { execute } as const
    })
  }
) {}
