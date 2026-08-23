import type { DateTime, Option, Redacted } from "effect"
import type { Forge } from "./forge.ts"

/**
 * The credential a Forge issued for a User at sign-in. It identifies the
 * person and, on GitHub, reaches only what the App is installed on — it is not
 * a key to every repository they can see (ADR-0005).
 *
 * Held encrypted at rest. Installation tokens are deliberately not modelled
 * here: they are minted on demand and expire within the hour, so they are never
 * persisted at all.
 */
export interface ForgeCredential {
  readonly forge: Forge
  readonly accessToken: Redacted.Redacted<string>
  readonly refreshToken: Option.Option<Redacted.Redacted<string>>
  readonly accessTokenExpiresAt: Option.Option<DateTime.Utc>
}
