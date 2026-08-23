import { Schema } from "effect"
import { RepoConnectionId } from "../../connections/domain/repo-connection.ts"
import { Repository } from "../../connections/domain/repository.ts"
import { UserId } from "../../connections/domain/user.ts"
import { DayWindow } from "./day-window.ts"

export const RunId = Schema.UUID.pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type

/**
 * Where a Run has got to. The two stages of the pipeline (ADR-0002) are visible
 * here on purpose: a User polling a Run can tell "still reading the Forge" from
 * "waiting on the model".
 *
 * `quiet` is a successful outcome and not a failure: a Quiet Day is a normal
 * part of building, and the Run that discovers one has done its job.
 */
export const RunState = Schema.Literal("queued", "collecting", "drafting", "succeeded", "failed", "quiet")
export type RunState = typeof RunState.Type

/** States a worker may still be holding a Run in. Nothing else is claimable or resumable. */
export const IN_FLIGHT_STATES = ["queued", "collecting", "drafting"] as const satisfies ReadonlyArray<RunState>

/** States a Run never leaves. */
export const TERMINAL_STATES = ["succeeded", "failed", "quiet"] as const satisfies ReadonlyArray<RunState>

export const isTerminal = (state: RunState): boolean => (TERMINAL_STATES as ReadonlyArray<RunState>).includes(state)

/** What caused a Run to start. Only a User can today; the schedule is out of scope for the MVP. */
export const Trigger = Schema.Literal("user", "schedule")
export type Trigger = typeof Trigger.Type

/**
 * One attempt to go from a repository and a Day Window to a Draft.
 *
 * A Run carries its own `repository` and lets go of the Repo Connection when
 * one is deleted, so disconnecting a repository never destroys the Runs — and
 * later the Drafts — a User already asked for. `repoConnectionId` is therefore
 * nullable and says "the entitlement that authorized this", not "where to read
 * the repository name from".
 *
 * `attempts` counts claims rather than failures: a Run interrupted by a deploy
 * is claimed again, which is what makes an interrupted deploy recoverable and
 * why processing has to be idempotent.
 */
export class Run extends Schema.Class<Run>("Run")({
  id: RunId,
  userId: UserId,
  repoConnectionId: Schema.NullOr(RepoConnectionId),
  repository: Repository,
  dayWindow: DayWindow,
  trigger: Trigger,
  state: RunState,
  attempts: Schema.Int,
  failureReason: Schema.NullOr(Schema.String),
  requestedAt: Schema.DateTimeUtc,
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  finishedAt: Schema.NullOr(Schema.DateTimeUtc)
}) {
  get isFinished(): boolean {
    return isTerminal(this.state)
  }
}

/**
 * There is no such Run *for this User*. One failure for two situations — it
 * never existed, or it belongs to somebody else — so asking about another
 * User's Run cannot confirm that it exists.
 */
export class RunNotFound extends Schema.TaggedError<RunNotFound>()("RunNotFound", {}) {}

/** How a Run ended. Failure carries a reason because the User is the one who has to read it. */
export type RunOutcome =
  | { readonly state: "succeeded" }
  | { readonly state: "quiet" }
  | { readonly state: "failed"; readonly reason: string }
