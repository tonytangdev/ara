import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "@effect/platform"
import { Schema } from "effect"
import { SessionAuthentication } from "../connections/api.ts"

/**
 * The Draft a Run wrote, with what it cost attached.
 *
 * The body is markdown, so it can be pasted wherever the User posts. `model`
 * and the token counts are part of the Draft rather than an admin view of it:
 * a User comparing two Drafts should be able to see which model wrote each, and
 * what the habit is costing, without asking anybody.
 *
 * `digestId` is here so that "why did it write that?" leads somewhere: the
 * Digest it was written from is a request away, and it is the only thing the
 * model was given.
 */
export class DraftResponse extends Schema.Class<DraftResponse>("DraftResponse")({
  id: Schema.String,
  runId: Schema.String,
  digestId: Schema.String,
  body: Schema.String,
  model: Schema.String,
  inputTokens: Schema.NullOr(Schema.Int),
  outputTokens: Schema.NullOr(Schema.Int),
  totalTokens: Schema.NullOr(Schema.Int),
  generatedAt: Schema.DateTimeUtc
}) {}

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
 * A Draft is reached through the Run that produced it, because the Run id is
 * what asking for one hands back. Listing Drafts and opening one by its own id
 * is #9. The group sits behind `SessionAuthentication`, so no endpoint here can
 * be reached without a `CurrentUser` to scope it to.
 */
export class DraftsApiGroup extends HttpApiGroup.make("drafts")
  .add(
    HttpApiEndpoint.get("read", "/v1/runs/:id/draft")
      .setPath(Schema.Struct({ id: Schema.UUID }))
      .addSuccess(DraftResponse)
      .addError(NoSuchDraft)
      .annotate(OpenApi.Summary, "The Draft a Run wrote")
  )
  .middleware(SessionAuthentication)
  .annotate(OpenApi.Description, "The build-in-public post Ara wrote from a day's Digest.") {}
