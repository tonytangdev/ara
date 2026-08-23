import { Context, type Effect } from "effect"
import type { Installation } from "../installation.ts"
import type { ForgeAuthorizationFailed } from "../ports/github-authorization.ts"
import type { ReachableRepository } from "../repository.ts"

/**
 * Driven (outbound) port for "what can Ara actually reach?".
 *
 * Which repositories are in scope is decided on the Forge's installation
 * screen, not in Ara's UI (ADR-0005), so this asks the installation what it can
 * see rather than asking for everything the User owns. It is an authorization
 * question, which is why it sits here beside `InstallationTokens` and not
 * behind the Forge-agnostic `RepoActivitySource` (ADR-0003).
 */
export class ReachableRepositories extends Context.Tag("domain/connections/ReachableRepositories")<
  ReachableRepositories,
  {
    readonly listFor: (
      installation: Installation
    ) => Effect.Effect<ReadonlyArray<ReachableRepository>, ForgeAuthorizationFailed>
  }
>() {}
