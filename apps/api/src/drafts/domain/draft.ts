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
