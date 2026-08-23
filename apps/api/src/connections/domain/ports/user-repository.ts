import { Context, type Effect, type Option } from "effect"
import type { TimeZone } from "../time-zone.ts"
import type { ForgeIdentity, User, UserId } from "../user.ts"

/**
 * Driven (outbound) port for Users. `resolve` is deliberately one operation
 * rather than find-then-create: "first sign-in creates, later sign-ins resolve
 * to the same User" is a single rule, and splitting it across two calls would
 * let two concurrent sign-ins create two Users.
 */
export class UserRepository extends Context.Tag("domain/connections/UserRepository")<
  UserRepository,
  {
    readonly resolve: (identity: ForgeIdentity) => Effect.Effect<User>
    readonly findById: (id: UserId) => Effect.Effect<Option.Option<User>>
    /** Records the timezone a User says they are in, and answers with the User as it now stands. */
    readonly setTimeZone: (id: UserId, timeZone: TimeZone) => Effect.Effect<Option.Option<User>>
  }
>() {}
