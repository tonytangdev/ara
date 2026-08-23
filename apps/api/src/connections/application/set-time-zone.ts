import { Effect, Option } from "effect"
import { UserRepository } from "../domain/ports/user-repository.ts"
import type { TimeZone } from "../domain/time-zone.ts"
import type { User } from "../domain/user.ts"

/**
 * Driving (inbound) port: tell Ara which timezone you are in.
 *
 * This is what makes a Day Window mean what the User thinks it means. Nothing
 * else can set it — the caller can only ever change their own, because the User
 * comes from the session and never from the request body.
 */
export class SetTimeZone extends Effect.Service<SetTimeZone>()("application/connections/SetTimeZone", {
  effect: Effect.gen(function* () {
    const users = yield* UserRepository

    const execute = (user: User, timeZone: TimeZone): Effect.Effect<User> =>
      users.setTimeZone(user.id, timeZone).pipe(
        // The User was resolved from a live session a moment ago, so a row that
        // has gone missing since is not a case worth reporting to the caller.
        Effect.map(Option.getOrElse(() => user)),
        Effect.tap((updated) =>
          Effect.logInfo("Recorded a User's timezone").pipe(
            Effect.annotateLogs({ userId: user.id, timeZone: updated.timeZone })
          )
        )
      )

    return { execute } as const
  })
}) {}
