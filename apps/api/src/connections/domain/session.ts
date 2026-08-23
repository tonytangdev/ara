import type { DateTime, Redacted } from "effect"
import type { UserId } from "./user.ts"

/**
 * A signed-in person's proof of identity, as held by Ara. The token itself is
 * never one of these fields: only its digest is stored, so a database leak does
 * not hand over anyone's session.
 */
export interface Session {
  readonly userId: UserId
  readonly expiresAt: DateTime.Utc
}

/**
 * What sign-in hands back: the session, plus the one and only time the raw
 * token exists outside the caller's browser. `Redacted` keeps it out of logs.
 */
export interface IssuedSession {
  readonly session: Session
  readonly token: Redacted.Redacted<string>
}
