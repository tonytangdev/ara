import { type DateTime, type Redacted, Schema } from "effect"
import { Forge } from "./forge.ts"

/**
 * A User's App installation on a Forge: the thing that decides which
 * repositories Ara can reach. A User may have none, which is a normal state
 * and not an error — they are signed in, they just have not installed the App
 * yet (ADR-0005).
 */
export class Installation extends Schema.Class<Installation>("Installation")({
  forge: Forge,
  /** The Forge's own id for the installation, e.g. GitHub's numeric one. */
  externalId: Schema.String,
  accountLogin: Schema.String
}) {}

/**
 * A short-lived token minted from an installation. Lives in memory for the
 * hour it is valid and is never written down.
 */
export interface InstallationToken {
  readonly token: Redacted.Redacted<string>
  readonly expiresAt: DateTime.Utc
}
