import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "@effect/platform"
import { Schema } from "effect"
import { SessionAuthentication } from "../connections/api.ts"
import { Forge } from "../connections/domain/forge.ts"
import { TimeZone } from "../connections/domain/time-zone.ts"
import { RunResponse } from "../runs/api.ts"
import { CalendarDay } from "../runs/domain/day-window.ts"
import { DRAFT_PAGE_SIZE, DraftCursorFromString, DraftShape, EditedBody } from "./domain/draft.ts"

/**
 * The Draft a Run wrote, with what it cost attached.
 *
 * The body is markdown, so it can be pasted wherever the User posts. `model`
 * and the token counts are part of the Draft rather than an admin view of it:
 * a User comparing two Drafts should be able to see which model wrote each, and
 * what the habit is costing, without asking anybody. Reasoning tokens are their
 * own line because on a reasoning model they are most of the bill, and a cost
 * that cannot be broken down is a cost nobody can act on.
 *
 * `digestId` is here so that "why did it write that?" leads somewhere: the
 * Digest it was written from is a request away, and it is the only thing the
 * model was given.
 *
 * `shape` is what makes a Quiet Draft identifiable as one. A short post is not
 * self-evidently a Quiet Draft — it could just be a short post — so the reader
 * is told which of the two shapes was asked for, and the Digest's own `isQuiet`
 * says why.
 *
 * `body` is always what the model wrote and `editedBody` is what the User made
 * of it, null until they touch it. They are two fields rather than one because
 * an edit must never destroy the generated text (user story 18); a client that
 * wants the postable version reads `editedBody ?? body`.
 */
export class DraftResponse extends Schema.Class<DraftResponse>("DraftResponse")({
  id: Schema.String,
  runId: Schema.String,
  digestId: Schema.String,
  shape: DraftShape,
  body: Schema.String,
  editedBody: Schema.NullOr(Schema.String),
  editedAt: Schema.NullOr(Schema.DateTimeUtc),
  model: Schema.String,
  inputTokens: Schema.NullOr(Schema.Int),
  outputTokens: Schema.NullOr(Schema.Int),
  /** Thinking, counted apart from the output where the provider reports it that way. */
  reasoningTokens: Schema.NullOr(Schema.Int),
  totalTokens: Schema.NullOr(Schema.Int),
  /** US dollars, to six decimal places. Null when the provider reported no usage to price. */
  costUsd: Schema.NullOr(Schema.Number),
  generatedAt: Schema.DateTimeUtc
}) {}

/**
 * One entry in the list: enough to choose between Drafts without reading them.
 *
 * The Day Window is reported as the day and the zone it was read in, the same
 * pair a Run carries, because "2026-08-22" on its own does not say which day it
 * was for the person who lived it.
 *
 * `isQuiet` is what separates a Quiet Draft — a few honest sentences about a
 * light day — from a full post, and is the one thing here a client cannot infer
 * from the rest. `isEdited` is the other: the bodies are absent on purpose — a
 * page of full posts is a large answer to give somebody who wants to open one
 * of them — so without it there is no way to see which Drafts have already been
 * through a human.
 */
export class DraftSummaryResponse extends Schema.Class<DraftSummaryResponse>("DraftSummaryResponse")({
  id: Schema.String,
  runId: Schema.String,
  digestId: Schema.String,
  forge: Forge,
  owner: Schema.String,
  name: Schema.String,
  day: CalendarDay,
  timeZone: TimeZone,
  isQuiet: Schema.Boolean,
  isEdited: Schema.Boolean,
  model: Schema.String,
  generatedAt: Schema.DateTimeUtc
}) {}

/**
 * One page of Drafts, newest first.
 *
 * `nextCursor` is null at the end of the list, so a client can stop without a
 * request that comes back empty. It is opaque and is only ever handed back as
 * `after`: what a position is made of is the server's business, and changing it
 * later must not be a breaking change.
 */
export class DraftPageResponse extends Schema.Class<DraftPageResponse>("DraftPageResponse")({
  items: Schema.Array(DraftSummaryResponse),
  nextCursor: Schema.NullOr(Schema.String)
}) {}

/**
 * How a client asks for a page. Both are optional: `GET /v1/drafts` with
 * nothing on it is the newest page, which is what somebody looking for
 * yesterday's post wants.
 */
export class ListDraftsUrlParams extends Schema.Class<ListDraftsUrlParams>("ListDraftsUrlParams")({
  limit: Schema.optional(Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, DRAFT_PAGE_SIZE.max))),
  after: Schema.optional(DraftCursorFromString)
}) {}

/**
 * The text the User wants the Draft to be.
 *
 * A replacement rather than a patch of the prose: editing a post is rewriting
 * it, and nothing here is trying to merge two versions of a paragraph. Blank is
 * refused at the edge, so a Draft can never be edited into having nothing to
 * post.
 */
export class EditDraftRequest extends Schema.Class<EditDraftRequest>("EditDraftRequest")({
  body: EditedBody
}) {}

/**
 * How a client asks for another take on the same day.
 *
 * One field, and it is a confirmation rather than an option: `discardEdit` is
 * only looked at when the Draft carries the User's own rewrite, and saying
 * nothing means "do not go past my work". A client that has not shown the User
 * what they are about to leave behind should not be sending it.
 *
 * What it confirms is narrower than it sounds. The edited Draft is kept, so
 * nothing is deleted; what is discarded is its place as the Draft this day
 * leads to.
 */
export class RegenerateDraftRequest extends Schema.Class<RegenerateDraftRequest>("RegenerateDraftRequest")({
  discardEdit: Schema.optionalWith(Schema.Boolean, { default: () => false })
}) {}

/**
 * This Draft has been edited, and the request did not say to write past it.
 *
 * 409 rather than 400: nothing about the request is malformed, and repeating it
 * with the confirmation is exactly what the client should do next.
 */
export class UnconfirmedEdit extends Schema.TaggedError<UnconfirmedEdit>()(
  "UnconfirmedEdit",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 409 })
) {}

/**
 * No Draft for this Run. The same answer whether the Run is somebody else's,
 * never existed, or has not written anything yet — so a 404 confirms nothing.
 */
export class NoSuchDraft extends Schema.TaggedError<NoSuchDraft>()(
  "NoSuchDraft",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 404 })
) {}

/**
 * Drafts: what a Run wrote.
 *
 * A Draft is reached two ways: through the Run that produced it, because the
 * Run id is what asking for one hands back, and by its own id out of the list
 * of everything the caller has accumulated. The list is where Ara stops being
 * useful only within a single Run.
 *
 * The group sits behind `SessionAuthentication`, so no endpoint here can be
 * reached without a `CurrentUser` to scope it to.
 */
export class DraftsApiGroup extends HttpApiGroup.make("drafts")
  .add(
    HttpApiEndpoint.get("read", "/v1/runs/:id/draft")
      .setPath(Schema.Struct({ id: Schema.UUID }))
      .addSuccess(DraftResponse)
      .addError(NoSuchDraft)
      .annotate(OpenApi.Summary, "The Draft a Run wrote")
  )
  .add(
    HttpApiEndpoint.get("list", "/v1/drafts")
      .setUrlParams(ListDraftsUrlParams)
      .addSuccess(DraftPageResponse)
      .annotate(OpenApi.Summary, "The caller's Drafts, newest first")
  )
  .add(
    HttpApiEndpoint.get("open", "/v1/drafts/:id")
      .setPath(Schema.Struct({ id: Schema.UUID }))
      .addSuccess(DraftResponse)
      .addError(NoSuchDraft)
      .annotate(OpenApi.Summary, "One Draft, in full")
  )
  .add(
    HttpApiEndpoint.patch("edit", "/v1/drafts/:id")
      .setPath(Schema.Struct({ id: Schema.UUID }))
      .setPayload(EditDraftRequest)
      .addSuccess(DraftResponse)
      .addError(NoSuchDraft)
      .annotate(OpenApi.Summary, "Replace a Draft's body with the User's own text")
  )
  .add(
    HttpApiEndpoint.post("regenerate", "/v1/drafts/:id/regenerate")
      .setPath(Schema.Struct({ id: Schema.UUID }))
      .setPayload(RegenerateDraftRequest)
      // 202 and a Run, not 200 and a Draft: the model has not been called yet.
      // The Run is polled like any other, and its Draft read from it when it
      // finishes — the earlier Draft stays readable throughout, and afterwards.
      .addSuccess(RunResponse, { status: 202 })
      .addError(NoSuchDraft)
      .addError(UnconfirmedEdit)
      .annotate(OpenApi.Summary, "Write this day again, from the Digest already collected")
  )
  .middleware(SessionAuthentication)
  .annotate(OpenApi.Description, "The build-in-public post Ara wrote from a day's Digest.") {}
