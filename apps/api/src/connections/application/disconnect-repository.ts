import { Effect } from "effect"
import { RepoConnectionRepository } from "../domain/ports/repo-connection-repository.ts"
import { type RepoConnectionId, RepoConnectionNotFound } from "../domain/repo-connection.ts"
import type { User } from "../domain/user.ts"

/**
 * Driving (inbound) port: stop watching a repository.
 *
 * Deleting removes Ara's entitlement to read the repository from now on; it
 * does not erase what the User already has. Runs and Drafts produced while the
 * connection existed are the User's own writing and outlive it — they keep
 * their own copy of `(forge, owner, name)` and let go of the connection, so
 * disconnecting never destroys a Draft someone might still want to post.
 *
 * Deleting a connection that is not this User's fails exactly as deleting one
 * that never existed does.
 */
export class DisconnectRepository extends Effect.Service<DisconnectRepository>()(
  "application/connections/DisconnectRepository",
  {
    effect: Effect.gen(function* () {
      const connections = yield* RepoConnectionRepository

      const execute = (user: User, id: RepoConnectionId): Effect.Effect<void, RepoConnectionNotFound> =>
        Effect.gen(function* () {
          const deleted = yield* connections.deleteOwnedBy(id, user.id)
          if (!deleted) {
            return yield* new RepoConnectionNotFound()
          }
          yield* Effect.logInfo("Disconnected a repository").pipe(
            Effect.annotateLogs({ userId: user.id, connectionId: id })
          )
        })

      return { execute } as const
    })
  }
) {}
