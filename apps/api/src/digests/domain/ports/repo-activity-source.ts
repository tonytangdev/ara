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
 * The Activity could not be read.
 *
 * `retryable` is the only classification the domain makes, and it is made here
 * because only the adapter can tell a Forge having a bad minute from an App
 * that was uninstalled. The case it exists for is the one that looks like a
 * hard failure and is not: a rate limit, Ara's own or GitHub's, means "not
 * now" rather than "never", and a Run that gave up on it would fail a User for
 * being busy. What is done about a retryable failure is the Run lifecycle's
 * business, not this port's; all that is promised here is an honest answer to
 * "is this worth trying again".
 *
 * It defaults to `false`, so a failure has to be argued into being retryable
 * rather than becoming one by omission.
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
