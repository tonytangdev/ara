import { Schema } from "effect"

/**
 * Which half of the pipeline a Run was in when it failed (ADR-0002). Spelled as
 * two of the Run's own states rather than as names of its own, because that is
 * exactly what it is: where a Run stopped, and where it is put back to resume.
 */
export const RunStage = Schema.Literal("collecting", "drafting")
export type RunStage = typeof RunStage.Type

/**
 * Whether trying the same thing again could plausibly work.
 *
 * `retryable` is a rate limit, a 5xx, a timeout, a model that answered with
 * nothing. `terminal` is a revoked authorization, a deleted repository, a
 * configuration that is wrong — nothing about waiting makes those different.
 */
export const FailureKind = Schema.Literal("retryable", "terminal")
export type FailureKind = typeof FailureKind.Type

/**
 * Why a Run stopped, in the two terms the Run lifecycle needs: something to
 * tell the User, and whether to try again.
 *
 * Classification is deliberately *not* made here. Only the adapter that made
 * the call can tell a rate limit from a revoked key, so each driven port
 * carries its own `retryable` flag and this type only reads it. That is what
 * lets rate limiting be added inside the GitHub and model adapters without the
 * runs module knowing, and what keeps this file free of any mention of HTTP.
 */
export class RunFailure extends Schema.TaggedError<RunFailure>()("RunFailure", {
  stage: RunStage,
  /** Written for the User, not for the log: what happened, in terms they can act on. */
  reason: Schema.String,
  kind: FailureKind
}) {}

/** A port failure, seen as the Run's failure: the port classified it, this names where it happened. */
export const failureIn = (
  stage: RunStage,
  failure: { readonly reason: string; readonly retryable: boolean }
): RunFailure => new RunFailure({ stage, reason: failure.reason, kind: failure.retryable ? "retryable" : "terminal" })

/**
 * A Run that broke rather than failed: a defect, not a failure any port
 * described. Retryable, because the commonest cause is a moment of bad luck
 * — a dropped connection, a process going down — and the attempt bound is what
 * stops a genuine bug being retried forever.
 */
export const unexpectedFailureIn = (stage: RunStage): RunFailure =>
  new RunFailure({
    stage,
    reason:
      stage === "collecting"
        ? "Something went wrong inside Ara while reading the repository."
        : "Something went wrong inside Ara while writing the Draft.",
    kind: "retryable"
  })

/**
 * What the User is finally told, once the Run has stopped for good.
 *
 * A Run that gave up after trying says so: "the model provider is down" reads
 * very differently when it is the fifth time of asking, and the difference is
 * the User's cue that waiting a minute and asking again is not the answer.
 */
export const finalReason = (failure: RunFailure, attempts: number): string =>
  failure.kind === "terminal" || attempts <= 1
    ? failure.reason
    : `${failure.reason} Ara tried ${attempts} times before stopping.`
