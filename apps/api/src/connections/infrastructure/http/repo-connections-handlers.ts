import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { AraApi } from "../../../http/api.ts"
import {
  NoSuchRepoConnection,
  ReachableRepositoryResponse,
  RepoConnectionResponse,
  RepositoryNotConnectable
} from "../../api.ts"
import { ConnectRepository } from "../../application/connect-repository.ts"
import { DisconnectRepository } from "../../application/disconnect-repository.ts"
import { ListReachableRepositories } from "../../application/list-reachable-repositories.ts"
import { ListRepoConnections } from "../../application/list-repo-connections.ts"
import { CurrentUser } from "../../domain/current-user.ts"
import type { RepoConnection, RepoConnectionId } from "../../domain/repo-connection.ts"
import { Repository } from "../../domain/repository.ts"

const toResponse = (connection: RepoConnection) =>
  new RepoConnectionResponse({
    id: connection.id,
    forge: connection.repository.forge,
    owner: connection.repository.owner,
    name: connection.repository.name,
    installationId: connection.installationExternalId,
    connectedAt: connection.connectedAt
  })

/**
 * Driving (inbound) adapter for Repo Connections.
 *
 * Every handler takes its User from `CurrentUser` and never from anything the
 * caller sent, so scoping is not something a handler can forget to do. The
 * "not yours" and "does not exist" cases arrive here as the same domain failure
 * and leave as the same 404 — the transport cannot leak a distinction the
 * domain has already refused to make.
 */
export const RepoConnectionsHandlersLive = HttpApiBuilder.group(AraApi, "repo-connections", (handlers) =>
  handlers
    .handle("listReachableRepositories", () =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const list = yield* ListReachableRepositories

        const reachable = yield* list
          .execute(user)
          .pipe(Effect.mapError((failure) => new RepositoryNotConnectable({ reason: failure.reason })))

        return reachable.map(
          (found) =>
            new ReachableRepositoryResponse({
              forge: found.repository.forge,
              owner: found.repository.owner,
              name: found.repository.name,
              isPrivate: found.isPrivate,
              installationId: found.installationExternalId
            })
        )
      })
    )
    .handle("connect", ({ payload }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const connect = yield* ConnectRepository

        const connection = yield* connect
          .execute(user, new Repository({ forge: payload.forge, owner: payload.owner, name: payload.name }))
          .pipe(Effect.mapError((failure) => new RepositoryNotConnectable({ reason: failure.reason })))

        return toResponse(connection)
      })
    )
    .handle("list", () =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const list = yield* ListRepoConnections
        const connections = yield* list.execute(user)

        return connections.map(toResponse)
      })
    )
    .handle("disconnect", ({ path }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const disconnect = yield* DisconnectRepository

        yield* disconnect
          .execute(user, path.id as RepoConnectionId)
          .pipe(Effect.mapError(() => new NoSuchRepoConnection({ message: "No such Repo Connection" })))
      })
    )
)
