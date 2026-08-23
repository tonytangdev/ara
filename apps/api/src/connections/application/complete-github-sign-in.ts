import { Effect } from "effect"
import { ForgeCredentialStore } from "../domain/ports/forge-credential-store.ts"
import { type ForgeAuthorizationFailed, GithubAuthorization } from "../domain/ports/github-authorization.ts"
import { SessionStore } from "../domain/ports/session-store.ts"
import { UserRepository } from "../domain/ports/user-repository.ts"
import type { IssuedSession } from "../domain/session.ts"
import type { User } from "../domain/user.ts"

export interface SignedIn {
  readonly user: User
  readonly session: IssuedSession
}

/**
 * Driving (inbound) port: finish sign-in.
 *
 * The whole of "first sign-in creates a User, later ones resolve to the same
 * User" lives in `UserRepository.resolve`; this use case is the order of
 * events — identify, remember what the Forge gave us, hand back a session.
 */
export class CompleteGithubSignIn extends Effect.Service<CompleteGithubSignIn>()(
  "application/connections/CompleteGithubSignIn",
  {
    effect: Effect.gen(function* () {
      const github = yield* GithubAuthorization
      const users = yield* UserRepository
      const credentials = yield* ForgeCredentialStore
      const sessions = yield* SessionStore

      const execute = (code: string): Effect.Effect<SignedIn, ForgeAuthorizationFailed> =>
        Effect.gen(function* () {
          const { credential, identity } = yield* github.completeSignIn(code)
          const user = yield* users.resolve(identity)
          yield* credentials.save(user.id, credential)
          const session = yield* sessions.issue(user.id)
          yield* Effect.logInfo("Signed in").pipe(Effect.annotateLogs({ userId: user.id, forge: user.forge }))
          return { user, session }
        })

      return { execute } as const
    })
  }
) {}
