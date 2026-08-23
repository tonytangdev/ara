import { Schema } from "effect"
import { RepoConnectionId } from "../../connections/domain/repo-connection.ts"
import { Repository } from "../../connections/domain/repository.ts"
import { UserId } from "../../connections/domain/user.ts"
import { DayWindow } from "./day-window.ts"
import { RunCost } from "./run-cost.ts"

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
 * A Run also carries what it cost. Money is recorded against the Run and not
 * only against the Draft because the Run is the thing a User asked for and can
 * name, and "what did this cost me" should not require finding a Draft id
 * first.
 *
 * `attempts` counts claims rather than failures: a Run interrupted by a deploy
 * is claimed again, which is what makes an interrupted deploy recoverable and
 * why processing has to be idempotent.
 *
 * `sourceDigestId` is what makes a Run a regeneration: the day it is about has
 * already been collected, so it starts at the Draft stage and never reads the
 * Forge (ADR-0002). Null is the ordinary case — collect the day, then write.
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
  /**
   * The Digest this Run must write from, when it is not going to collect one.
   * Set only on a regeneration, which is why `isRegeneration` reads it rather
   * than a flag of its own: there is one fact here, not two that can disagree.
   */
  sourceDigestId: Schema.NullOr(Schema.UUID),
  failureReason: Schema.NullOr(Schema.String),
  /**
   * What the Run spent, once it has spent anything. Null until the model has
   * answered — a Run that is still collecting has cost nothing yet, and saying
   * "zero" would be a claim rather than an absence.
   */
  cost: Schema.NullOr(RunCost),
  requestedAt: Schema.DateTimeUtc,
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  finishedAt: Schema.NullOr(Schema.DateTimeUtc)
}) {
  get isFinished(): boolean {
    return isTerminal(this.state)
  }

  /**
   * Whether this Run writes from a Digest somebody else's Run collected.
   *
   * The one thing that follows from it is the stage it starts at, and that is
   * the point: a regeneration is an ordinary Run with the expensive half
   * already done, not a second kind of Run with a lifecycle of its own.
   */
  get isRegeneration(): boolean {
    return this.sourceDigestId !== null
  }

  /** Where this Run's first attempt begins. A collected day is one it need not read again. */
  get startsAt(): "collecting" | "drafting" {
    return this.isRegeneration ? "drafting" : "collecting"
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
