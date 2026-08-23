import { Effect, Layer, Option } from "effect"
import { SessionAuthentication, Unauthorized } from "../../api.ts"
import { AuthenticateSession } from "../../application/authenticate-session.ts"

/**
 * Driving (inbound) adapter for the authentication middleware: the session
 * cookie in, a `CurrentUser` out. Every way of failing — no cookie, unknown
 * token, expired session — produces the same 401 with the same wording, so the
 * response tells an attacker nothing about which it was.
 */
export const SessionAuthenticationLive = Layer.effect(
  SessionAuthentication,
  Effect.gen(function* () {
    const authenticate = yield* AuthenticateSession

    return SessionAuthentication.of({
      session: (token) =>
        authenticate.execute(token).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => new Unauthorized({ message: "Sign in with GitHub to use this endpoint" }),
              onSome: Effect.succeed
            })
          )
        )
    })
  })
)
