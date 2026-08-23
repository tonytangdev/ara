import { Context, type Effect, type Option } from "effect"
import type { RepoConnection, RepoConnectionId } from "../repo-connection.ts"
import type { Repository } from "../repository.ts"
import type { UserId } from "../user.ts"

/**
 * Driven (outbound) port for Repo Connections.
 *
 * Every operation takes the owning `UserId` rather than offering a plain
 * `findById` that a caller could forget to scope. Ownership is not a filter
 * applied on the way out; it is part of asking the question, so there is no
 * shape of call that reads another User's connection.
 */
export class RepoConnectionRepository extends Context.Tag("domain/connections/RepoConnectionRepository")<
  RepoConnectionRepository,
  {
    /**
     * Connect a repository, or return the connection that already exists.
     * Connecting twice is the same as connecting once — a double-clicked button
     * is not an error worth showing anyone.
     */
    readonly connect: (
      userId: UserId,
      repository: Repository,
      installationExternalId: string
    ) => Effect.Effect<RepoConnection>
    readonly listFor: (userId: UserId) => Effect.Effect<ReadonlyArray<RepoConnection>>
    readonly findOwnedBy: (id: RepoConnectionId, userId: UserId) => Effect.Effect<Option.Option<RepoConnection>>
    /** `false` when this User has no such connection, whoever else might. */
    readonly deleteOwnedBy: (id: RepoConnectionId, userId: UserId) => Effect.Effect<boolean>
  }
>() {}
