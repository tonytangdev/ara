import { Schema } from "effect"

export const DraftId = Schema.UUID.pipe(Schema.brand("DraftId"))
export type DraftId = typeof DraftId.Type

/**
 * How long a full Draft should run to.
 *
 * A floor and a ceiling rather than a target, and both are load-bearing. The
 * ceiling is what keeps a Draft postable without further cutting; the floor is
 * what the prototype found drives the model to invent detail when the day was
 * thin, which is why a Quiet Day gets a different shape entirely (#8) instead
 * of this range applied to less material.
 */
export const FULL_DRAFT_WORDS = { min: 150, max: 250 } as const

/**
 * How long a Quiet Draft should run to.
 *
 * Short on purpose, and the shortness is the correctness measure. The prototype
 * held the full range over a thin Digest and watched the model fill the gap with
 * things that never happened — files nobody touched, a motivation nobody had, an
 * arc from a morning of two commits. Forty to ninety words is about as much as a
 * light day can honestly carry, so it is what a light day is asked for.
 */
export const QUIET_DRAFT_WORDS = { min: 40, max: 90 } as const

/**
 * Which of the two shapes a Draft took (CONTEXT: Draft, Quiet Draft).
 *
 * Not a style flag. The shape follows deterministically from the Digest's own
 * `isQuiet`, which was decided before any model was called, and it is carried on
 * the Draft so that a Quiet Draft is identifiable as one when it is read back
 * rather than something a reader has to infer from its length.
 */
export const DraftShape = Schema.Literal("full", "quiet")
export type DraftShape = typeof DraftShape.Type

/** How long a Draft of this shape was asked to run to. */
export const wordsFor = (shape: DraftShape): { readonly min: number; readonly max: number } =>
  shape === "quiet" ? QUIET_DRAFT_WORDS : FULL_DRAFT_WORDS

/**
 * Prose the model did not actually write.
 *
 * The model sometimes answers with reasoning and no message content. That is
 * not an HTTP error and nothing downstream would notice it, so the emptiness
 * test lives here, next to the domain object it protects, and is applied both
 * at the adapter and before anything is persisted.
 */
export const isBlank = (body: string): boolean => body.trim().length === 0

/** How many words a body runs to. Whitespace-separated; good enough to log and to judge by. */
export const wordCount = (body: string): number =>
  body
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "").length

/**
 * What the model gave back: the prose, and what it cost.
 *
 * The model's name and the token counts travel with the body rather than being
 * logged beside it, because both are questions asked *of a Draft* later — "which
 * model wrote this one" when quality changes, and "what is this habit costing"
 * when a scheduler is firing daily. Counts are nullable: a provider that
 * declines to report usage is not a reason to lose the Draft.
 */
export class WrittenDraft extends Schema.Class<WrittenDraft>("WrittenDraft")({
  body: Schema.String,
  model: Schema.String,
  inputTokens: Schema.NullOr(Schema.Int),
  outputTokens: Schema.NullOr(Schema.Int),
  totalTokens: Schema.NullOr(Schema.Int)
}) {}

/**
 * A Draft as it was persisted: the prose, and the Digest it was written from.
 *
 * It hangs off both the Run that produced it and the Digest it came from. The
 * Digest is the interesting one: it is what makes a Draft explainable ("it said
 * that because the day contained this") and what regeneration reads from
 * instead of going back to the Forge (ADR-0002).
 */
export class StoredDraft extends Schema.Class<StoredDraft>("StoredDraft")({
  id: Schema.UUID,
  runId: Schema.UUID,
  digestId: Schema.UUID,
  /** Full or Quiet, read from the Digest it was written from rather than guessed at from the prose. */
  shape: DraftShape,
  body: Schema.String,
  model: Schema.String,
  inputTokens: Schema.NullOr(Schema.Int),
  outputTokens: Schema.NullOr(Schema.Int),
  totalTokens: Schema.NullOr(Schema.Int),
  generatedAt: Schema.DateTimeUtc
}) {}

/**
 * There is no Draft for this Run *for this User*. One failure for three
 * situations — no such Run, somebody else's Run, or a Run that has not written
 * anything yet — so asking cannot confirm another User's Run exists.
 */
export class DraftNotFound extends Schema.TaggedError<DraftNotFound>()("DraftNotFound", {}) {}
