import { FetchHttpClient } from "@effect/platform"
import { Layer } from "effect"
import { AuthenticateSession } from "./application/authenticate-session.ts"
import { BeginGithubSignIn } from "./application/begin-github-sign-in.ts"
import { CompleteGithubSignIn } from "./application/complete-github-sign-in.ts"
import { ConnectRepository } from "./application/connect-repository.ts"
import { DescribeCurrentUser } from "./application/describe-current-user.ts"
import { DisconnectRepository } from "./application/disconnect-repository.ts"
import { ListReachableRepositories } from "./application/list-reachable-repositories.ts"
import { ListRepoConnections } from "./application/list-repo-connections.ts"
import { RecordGithubInstallation } from "./application/record-github-installation.ts"
import { SetTimeZone } from "./application/set-time-zone.ts"
import { SecretCipher } from "./infrastructure/crypto/secret-cipher.ts"
import { GithubAppJwt } from "./infrastructure/github/github-app-jwt.ts"
import { GithubAuthorizationLive } from "./infrastructure/github/github-authorization.ts"
import { GithubInstallationTokensLive } from "./infrastructure/github/github-installation-tokens.ts"
import { GithubReachableRepositoriesLive } from "./infrastructure/github/github-reachable-repositories.ts"
import { ConnectionsHandlersLive } from "./infrastructure/http/connections-handlers.ts"
import { RepoConnectionsHandlersLive } from "./infrastructure/http/repo-connections-handlers.ts"
import { SessionAuthenticationLive } from "./infrastructure/http/session-authentication.ts"
import { PgForgeCredentialStoreLive } from "./infrastructure/persistence/pg-forge-credential-store.ts"
import { PgInstallationRepositoryLive } from "./infrastructure/persistence/pg-installation-repository.ts"
import { PgRepoConnectionRepositoryLive } from "./infrastructure/persistence/pg-repo-connection-repository.ts"
import { PgSessionStoreLive } from "./infrastructure/persistence/pg-session-store.ts"
import { PgUserRepositoryLive } from "./infrastructure/persistence/pg-user-repository.ts"

/**
 * The token that reads a repository, ready to use.
 *
 * Exported because it is the one credential path in the system (ADR-0005) and
 * other modules need it: the digests module's GitHub adapter mints its token
 * through this. It is exported as a *layer value* rather than rebuilt per
 * caller so that layer memoization gives every one of them the same instance —
 * and therefore one token cache, not one each.
 */
export const InstallationTokensLive = GithubInstallationTokensLive.pipe(
  Layer.provide(GithubAppJwt.Default),
  Layer.provide(FetchHttpClient.layer)
)

/**
 * Everything that talks to GitHub, sharing one HTTP client, one App key and —
 * because `InstallationTokens` is merged in rather than only provided — one
 * token cache, so listing repositories does not mint a second token beside the
 * one the rest of the module is already holding.
 */
const GithubLive = Layer.mergeAll(GithubAuthorizationLive, GithubReachableRepositoriesLive).pipe(
  Layer.provideMerge(InstallationTokensLive),
  Layer.provide(GithubAppJwt.Default),
  Layer.provide(FetchHttpClient.layer)
)

const PersistenceLive = Layer.mergeAll(
  PgUserRepositoryLive,
  PgSessionStoreLive,
  PgInstallationRepositoryLive,
  PgRepoConnectionRepositoryLive,
  PgForgeCredentialStoreLive.pipe(Layer.provide(SecretCipher.Default))
)

const DrivenLive = Layer.merge(GithubLive, PersistenceLive)

/**
 * The connections module's public face. Nothing outside this folder should
 * import anything deeper than these two exports:
 *
 * - `./api.ts` — the HTTP contract this module contributes to the API surface.
 * - `ConnectionsLive` — the module, fully wired.
 *
 * `SqlClient` is left as a requirement, so the composition root decides which
 * Postgres the module reads and writes.
 *
 * Authorization is wired here, GitHub-shaped, and stays out of the
 * Forge-agnostic Activity port (ADR-0003): `InstallationTokens` is what a
 * future `RepoActivitySource` adapter will ask for a credential, rather than
 * holding one of its own.
 */
export const ConnectionsLive = Layer.mergeAll(ConnectionsHandlersLive, RepoConnectionsHandlersLive).pipe(
  // Merged rather than only provided: the API's middleware map is built from
  // the context it is given, so the authentication middleware has to come out
  // of this layer as well as into the handlers.
  Layer.provideMerge(SessionAuthenticationLive),
  Layer.provide(
    Layer.mergeAll(
      AuthenticateSession.Default,
      BeginGithubSignIn.Default,
      CompleteGithubSignIn.Default,
      ConnectRepository.Default,
      DescribeCurrentUser.Default,
      DisconnectRepository.Default,
      ListReachableRepositories.Default,
      ListRepoConnections.Default,
      RecordGithubInstallation.Default,
      SetTimeZone.Default
    )
  ),
  Layer.provide(DrivenLive)
)

export {
  ConnectionsApiGroup,
  MeResponse,
  NoSuchRepoConnection,
  RepoConnectionsApiGroup,
  SESSION_COOKIE,
  SessionAuthentication,
  SignInFailed,
  Unauthorized
} from "./api.ts"
export { CurrentUser } from "./domain/current-user.ts"
export { Forge } from "./domain/forge.ts"
export { InstallationTokens } from "./domain/ports/installation-tokens.ts"
export { RepoConnectionRepository } from "./domain/ports/repo-connection-repository.ts"
export { RepoConnection, RepoConnectionId, RepoConnectionNotFound } from "./domain/repo-connection.ts"
export { Repository } from "./domain/repository.ts"
export { DEFAULT_TIME_ZONE, TimeZone } from "./domain/time-zone.ts"
export { User, UserId } from "./domain/user.ts"
/**
 * The Repo Connection adapter on its own, for modules that need the port but
 * not the rest of this one. The runs module asks whether a Run is entitled to
 * a repository through this, rather than reaching for the table itself.
 */
export { PgRepoConnectionRepositoryLive as RepoConnectionRepositoryLive } from "./infrastructure/persistence/pg-repo-connection-repository.ts"
