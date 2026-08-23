import { Context, type Effect } from "effect"
import type { Installation, InstallationToken } from "../installation.ts"
import type { ForgeAuthorizationFailed } from "./github-authorization.ts"

/**
 * Driven (outbound) port for the token that actually reads a repository.
 *
 * Ara holds no long-lived repository credential (ADR-0005): a token is minted
 * from the App's private key when it is needed and refreshed once it is close
 * to expiring. Callers ask for a valid token and get one; whether that meant a
 * round trip to GitHub is not their concern.
 */
export class InstallationTokens extends Context.Tag("domain/connections/InstallationTokens")<
  InstallationTokens,
  {
    readonly tokenFor: (installation: Installation) => Effect.Effect<InstallationToken, ForgeAuthorizationFailed>
  }
>() {}
