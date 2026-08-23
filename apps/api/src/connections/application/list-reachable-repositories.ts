import { Effect } from "effect"
import type { ForgeAuthorizationFailed } from "../domain/ports/github-authorization.ts"
import { InstallationRepository } from "../domain/ports/installation-repository.ts"
import { ReachableRepositories } from "../domain/ports/reachable-repositories.ts"
import type { ReachableRepository } from "../domain/repository.ts"
import type { User } from "../domain/user.ts"

/**
 * Driving (inbound) port: what could this User connect?
 *
 * A User with no installation gets an empty list rather than an error — being
 * signed in and having installed the App are separate facts (ADR-0005), and
 * "nothing to connect yet" is a complete answer to the question asked.
 */
export class ListReachableRepositories extends Effect.Service<ListReachableRepositories>()(
  "application/connections/ListReachableRepositories",
  {
    effect: Effect.gen(function* () {
      const installations = yield* InstallationRepository
      const reachable = yield* ReachableRepositories

      const execute = (user: User): Effect.Effect<ReadonlyArray<ReachableRepository>, ForgeAuthorizationFailed> =>
        installations.listFor(user.id).pipe(
          Effect.flatMap((installed) => Effect.forEach(installed, reachable.listFor)),
          Effect.map((perInstallation) => perInstallation.flat())
        )

      return { execute } as const
    })
  }
) {}
