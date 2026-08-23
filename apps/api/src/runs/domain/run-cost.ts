import { Schema } from "effect"

/**
 * What a Run consumed, and what that came to in money.
 *
 * It hangs off the Run rather than only off the Draft because the Run is what a
 * User holds an id to and what they ask questions of: "what did yesterday's
 * post cost me" is asked of the day's Run, not of a Draft id they never saw.
 * The Draft keeps its own copy of the same numbers, which is not duplication so
 * much as two different questions — what this Draft cost, and what this Run
 * spent in total.
 *
 * `reasoningTokens` is counted inside `outputTokens`, not beside it. It is
 * reported anyway because Ara writes with a reasoning model, where thinking is
 * most of the bill and a total with no breakdown tells a User nothing they can
 * act on.
 *
 * Every field is nullable, including the money: a provider that declines to
 * report usage leaves a Run with a Draft and no cost, and that is a less bad
 * outcome than either losing the Draft or inventing a figure.
 */
export class RunCost extends Schema.Class<RunCost>("RunCost")({
  inputTokens: Schema.NullOr(Schema.Int),
  outputTokens: Schema.NullOr(Schema.Int),
  reasoningTokens: Schema.NullOr(Schema.Int),
  totalTokens: Schema.NullOr(Schema.Int),
  /** US dollars, to six decimal places. One Draft costs a fraction of a cent, and a habit is daily. */
  costUsd: Schema.NullOr(Schema.Number)
}) {}
