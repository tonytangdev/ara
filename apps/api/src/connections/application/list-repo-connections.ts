import { Effect } from "effect"
import { RepoConnectionRepository } from "../domain/ports/repo-connection-repository.ts"
import type { RepoConnection } from "../domain/repo-connection.ts"
import type { User } from "../domain/user.ts"

/** Driving (inbound) port: what is Ara watching for this User, and nobody else. */
export class ListRepoConnections extends Effect.Service<ListRepoConnections>()(
  "application/connections/ListRepoConnections",
  {
    effect: Effect.gen(function* () {
      const connections = yield* RepoConnectionRepository

      const execute = (user: User): Effect.Effect<ReadonlyArray<RepoConnection>> => connections.listFor(user.id)

      return { execute } as const
    })
  }
) {}
