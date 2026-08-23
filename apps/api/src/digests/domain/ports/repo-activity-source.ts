import { Context, type Effect, Schema } from "effect"
import type { Repository } from "../../../connections/domain/repository.ts"
import type { DayWindow } from "../../../runs/domain/day-window.ts"
import type { RepositoryActivity } from "../activity.ts"

/** What to read, when, and on whose authority. */
export interface ActivityRequest {
  readonly repository: Repository
  readonly dayWindow: DayWindow
  /**
   * The Forge-side authorization the repository is reachable through — a GitHub
   * App installation id today. A reference, never a credential: the adapter
   * mints the token it needs and holds none (ADR-0005).
   */
  readonly installationExternalId: string
}

/**
 * The Activity could not be read. One failure covers "GitHub is having a bad
 * minute" and "the App was uninstalled", because from here they are the same
 * fact — with one distinction the Run needs in order to recover.
 *
 * `retryable` is that distinction, and it is made in the adapter because only
 * the caller of the Forge can tell a rate limit from a revoked installation.
 * Adding rate limiting inside an adapter therefore changes nothing above this
 * line: whatever the adapter cannot ride out, it classifies.
 *
 * It defaults to terminal. Saying a failure is worth retrying is a claim about
 * it, and a failure nobody has classified should stop and explain itself rather
 * than quietly cost five attempts.
 */
export class ActivityUnavailable extends Schema.TaggedError<ActivityUnavailable>()("ActivityUnavailable", {
  reason: Schema.String,
  retryable: Schema.optionalWith(Schema.Boolean, { default: () => false })
}) {}

/**
 * Driven (outbound) port: given a repository and a Day Window, what happened.
 *
 * Named for what the domain needs rather than for who provides it (ADR-0003).
 * GitHub is the only Forge with an adapter, and no application code above this
 * line knows that. Authorization deliberately stays outside: this port is only
 * about reading Activity, and credentials remain a Forge-specific concern.
 *
 * The port promises no diffs. Its vocabulary — subjects, paths, line counts —
 * has no room for source code, which is what makes ADR-0004 a property of the
 * design rather than a rule somebody has to keep following.
 */
export class RepoActivitySource extends Context.Tag("domain/digests/RepoActivitySource")<
  RepoActivitySource,
  {
    readonly activityFor: (request: ActivityRequest) => Effect.Effect<RepositoryActivity, ActivityUnavailable>
  }
>() {}
