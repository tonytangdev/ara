import { Context, type Effect, Schema } from "effect"
import type { ForgeCredential } from "../forge-credential.ts"
import type { Installation } from "../installation.ts"
import type { ForgeIdentity } from "../user.ts"

/**
 * Sign-in failed on the Forge's side: a state that did not match, a code that
 * was already spent, GitHub refusing us. Carries a reason fit to be read by a
 * human and, deliberately, nothing that came out of a credential.
 */
export class ForgeAuthorizationFailed extends Schema.TaggedError<ForgeAuthorizationFailed>()(
  "ForgeAuthorizationFailed",
  { reason: Schema.String }
) {}

/**
 * Driven (outbound) port for authorizing against GitHub.
 *
 * Named for the Forge on purpose. ADR-0003 keeps reading Activity behind the
 * Forge-agnostic `RepoActivitySource`, but authorization does not generalise:
 * GitHub has App installations, GitLab has OAuth apps and project tokens, and
 * one abstraction over both would leak. So this port stays GitHub-shaped and
 * lives outside the Activity port entirely.
 */
export class GithubAuthorization extends Context.Tag("domain/connections/GithubAuthorization")<
  GithubAuthorization,
  {
    /** Where to send the browser, plus the state to hand back on return. */
    readonly beginSignIn: Effect.Effect<{ readonly url: string; readonly state: string }>
    /** Trade the callback's code for who the person is and what we may hold. */
    readonly completeSignIn: (
      code: string
    ) => Effect.Effect<
      { readonly identity: ForgeIdentity; readonly credential: ForgeCredential },
      ForgeAuthorizationFailed
    >
    /** What GitHub says about an installation the person just completed. */
    readonly describeInstallation: (externalId: string) => Effect.Effect<Installation, ForgeAuthorizationFailed>
  }
>() {}
