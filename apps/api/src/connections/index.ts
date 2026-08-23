import { FetchHttpClient } from "@effect/platform"
import { Layer } from "effect"
import { AuthenticateSession } from "./application/authenticate-session.ts"
import { BeginGithubSignIn } from "./application/begin-github-sign-in.ts"
import { CompleteGithubSignIn } from "./application/complete-github-sign-in.ts"
import { DescribeCurrentUser } from "./application/describe-current-user.ts"
import { RecordGithubInstallation } from "./application/record-github-installation.ts"
import { SecretCipher } from "./infrastructure/crypto/secret-cipher.ts"
import { GithubAppJwt } from "./infrastructure/github/github-app-jwt.ts"
import { GithubAuthorizationLive } from "./infrastructure/github/github-authorization.ts"
import { GithubInstallationTokensLive } from "./infrastructure/github/github-installation-tokens.ts"
import { ConnectionsHandlersLive } from "./infrastructure/http/connections-handlers.ts"
import { SessionAuthenticationLive } from "./infrastructure/http/session-authentication.ts"
import { PgForgeCredentialStoreLive } from "./infrastructure/persistence/pg-forge-credential-store.ts"
import { PgInstallationRepositoryLive } from "./infrastructure/persistence/pg-installation-repository.ts"
import { PgSessionStoreLive } from "./infrastructure/persistence/pg-session-store.ts"
import { PgUserRepositoryLive } from "./infrastructure/persistence/pg-user-repository.ts"

/** Everything that talks to GitHub, sharing one HTTP client and one App key. */
const GithubLive = Layer.mergeAll(GithubAuthorizationLive, GithubInstallationTokensLive).pipe(
  Layer.provide(GithubAppJwt.Default),
  Layer.provide(FetchHttpClient.layer)
)

const PersistenceLive = Layer.mergeAll(
  PgUserRepositoryLive,
  PgSessionStoreLive,
  PgInstallationRepositoryLive,
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
export const ConnectionsLive = ConnectionsHandlersLive.pipe(
  // Merged rather than only provided: the API's middleware map is built from
  // the context it is given, so the authentication middleware has to come out
  // of this layer as well as into the handlers.
  Layer.provideMerge(SessionAuthenticationLive),
  Layer.provide(
    Layer.mergeAll(
      AuthenticateSession.Default,
      BeginGithubSignIn.Default,
      CompleteGithubSignIn.Default,
      DescribeCurrentUser.Default,
      RecordGithubInstallation.Default
    )
  ),
  Layer.provide(DrivenLive)
)

export { ConnectionsApiGroup, MeResponse, SESSION_COOKIE, SignInFailed, Unauthorized } from "./api.ts"
export { InstallationTokens } from "./domain/ports/installation-tokens.ts"
