import { Schema } from "effect"
import { Repository } from "../../connections/domain/repository.ts"
import { DayWindow } from "../../runs/domain/day-window.ts"

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
  /**
   * What the model spent thinking, where the provider reports it apart from the
   * output tokens. On a reasoning model this is most of the bill, so it is a
   * number in its own right rather than a detail folded into the total.
   */
  reasoningTokens: Schema.NullOr(Schema.Int),
  totalTokens: Schema.NullOr(Schema.Int),
  /** What the call cost in US dollars, priced from the counts above. Null when the provider said nothing. */
  costUsd: Schema.NullOr(Schema.Number)
}) {}

/**
 * Prose a human is offering as their own.
 *
 * The one rule an edit has to keep is the one the generated body already keeps:
 * a Draft that says nothing is not a Draft. An edit down to whitespace is a
 * bad request rather than a Draft with no postable text in it, and rejecting it
 * at the edge means no use case or adapter has to hold that thought.
 */
export const EditedBody = Schema.String.pipe(Schema.filter((body) => !isBlank(body))).annotations({
  identifier: "EditedBody",
  description: "The text the User wants the Draft to be. Cannot be blank."
})

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
  /** What the model wrote. Never overwritten, whatever a User does to it afterwards. */
  body: Schema.String,
  /**
   * What the User made of it, or null while they have not touched it.
   *
   * Beside the generated body rather than on top of it, so that regeneration
   * can see human work before it writes anything (#11) and so that "what does
   * this User always change?" stays an answerable question (user story 18).
   */
  editedBody: Schema.NullOr(Schema.String),
  /** When the edit was made, and null with it: the pair is the "has been edited" fact. */
  editedAt: Schema.NullOr(Schema.DateTimeUtc),
  model: Schema.String,
  inputTokens: Schema.NullOr(Schema.Int),
  outputTokens: Schema.NullOr(Schema.Int),
  reasoningTokens: Schema.NullOr(Schema.Int),
  totalTokens: Schema.NullOr(Schema.Int),
  costUsd: Schema.NullOr(Schema.Number),
  generatedAt: Schema.DateTimeUtc
}) {}

/**
 * There is no Draft for this Run *for this User*. One failure for three
 * situations — no such Run, somebody else's Run, or a Run that has not written
 * anything yet — so asking cannot confirm another User's Run exists.
 */
export class DraftNotFound extends Schema.TaggedError<DraftNotFound>()("DraftNotFound", {}) {}

/**
 * How many Drafts one page of the list carries.
 *
 * The ceiling is the load-bearing half: Drafts accumulate one per Run forever,
 * so "list my Drafts" has to be a bounded question however long the habit has
 * been running. The default is a screen's worth — enough to recognise the one
 * you meant without asking for the rest.
 */
export const DRAFT_PAGE_SIZE = { default: 20, max: 100 } as const

/**
 * Where the previous page of Drafts stopped.
 *
 * A position rather than an offset: the list is ordered by `generatedAt` and
 * broken ties by `id`, and the next page is everything strictly below that
 * pair. An offset would skip or repeat entries as new Drafts land at the top,
 * which is precisely what happens while a Run the User just asked for finishes.
 */
export class DraftCursor extends Schema.Class<DraftCursor>("DraftCursor")({
  generatedAt: Schema.DateTimeUtc,
  id: Schema.UUID
}) {}

/**
 * The cursor as a client sees it: one opaque string, and not a shape anybody
 * outside is invited to build by hand. Decoding is part of the schema, so a
 * cursor that has been tampered with fails at the edge as a bad request rather
 * than reaching a query.
 */
export const DraftCursorFromString = Schema.compose(
  Schema.StringFromBase64Url,
  Schema.parseJson(DraftCursor)
).annotations({
  identifier: "DraftCursor",
  description: "An opaque position in the Draft list, taken from a previous page's nextCursor"
})

/** The cursor that would ask for whatever comes after this Draft. */
export const cursorAfter = (summary: DraftSummary): DraftCursor =>
  new DraftCursor({ generatedAt: summary.generatedAt, id: summary.id })

/**
 * One Draft as the list shows it: enough to choose between entries, and not the
 * prose itself.
 *
 * Repository and Day Window are here because a Draft on its own is undated
 * prose — "which day was this?" is the question a list of them has to answer.
 * The body is deliberately absent: a page of twenty full posts is a large
 * response to send somebody who wants to open one of them.
 */
export class DraftSummary extends Schema.Class<DraftSummary>("DraftSummary")({
  id: Schema.UUID,
  runId: Schema.UUID,
  digestId: Schema.UUID,
  repository: Repository,
  dayWindow: DayWindow,
  /**
   * Which of the two shapes it took: the same fact a single Draft carries, so
   * a Quiet Draft is recognisable in the list without opening it. Read from the
   * Digest's own Quiet Day judgement, which is where that judgement is made.
   */
  shape: DraftShape,
  /**
   * Whether a human has been through it. The list carries no bodies, so this is
   * the only place an edited Draft can be told apart from an untouched one
   * without opening it.
   */
  isEdited: Schema.Boolean,
  model: Schema.String,
  generatedAt: Schema.DateTimeUtc
}) {}

/**
 * One page of Drafts, newest first. `nextCursor` is null when this page is the
 * end of the list, so "is there more?" needs no second request to answer.
 */
export interface DraftPage {
  readonly items: ReadonlyArray<DraftSummary>
  readonly nextCursor: DraftCursor | null
}
