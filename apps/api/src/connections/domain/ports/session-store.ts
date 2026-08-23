import { Context, type Effect, type Option, type Redacted } from "effect"
import type { IssuedSession, Session } from "../session.ts"
import type { UserId } from "../user.ts"

/**
 * Driven (outbound) port for sessions. How a token is generated, and the fact
 * that only its digest is kept, are the adapter's business: the application
 * asks for a session and later asks who a token belongs to.
 *
 * `resolve` returns `None` for a token that is unknown, revoked or expired —
 * the caller cannot tell them apart, and should not.
 */
export class SessionStore extends Context.Tag("domain/connections/SessionStore")<
  SessionStore,
  {
    readonly issue: (userId: UserId) => Effect.Effect<IssuedSession>
    readonly resolve: (token: Redacted.Redacted<string>) => Effect.Effect<Option.Option<Session>>
    readonly revoke: (token: Redacted.Redacted<string>) => Effect.Effect<void>
  }
>() {}
