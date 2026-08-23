import { Effect, Option, type Redacted } from "effect"
import { SessionStore } from "../domain/ports/session-store.ts"
import { UserRepository } from "../domain/ports/user-repository.ts"
import type { User } from "../domain/user.ts"

/**
 * Driving (inbound) port: turn a session token into the User it belongs to, or
 * nothing. Every reason a token can fail — absent, unknown, revoked, expired —
 * collapses to `None` here, because a caller who is not signed in learns
 * nothing from being told which.
 */
export class AuthenticateSession extends Effect.Service<AuthenticateSession>()(
  "application/connections/AuthenticateSession",
  {
    effect: Effect.gen(function* () {
      const sessions = yield* SessionStore
      const users = yield* UserRepository

      const execute = (token: Redacted.Redacted<string>): Effect.Effect<Option.Option<User>> =>
        Effect.flatMap(
          sessions.resolve(token),
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: (session) => users.findById(session.userId)
          })
        )

      return { execute } as const
    })
  }
) {}
