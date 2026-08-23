import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "@effect/platform"
import { Schema } from "effect"
import { SessionAuthentication } from "../connections/api.ts"
import { Forge } from "../connections/domain/forge.ts"
import { CalendarDay } from "../runs/domain/day-window.ts"
import { AreaChurn, CommitSummary, DigestTotals, FileChurn, PullRequestSummary } from "./domain/digest.ts"

/**
 * What Ara believes happened that day, exactly as it was stored.
 *
 * The response is the Digest and not a view of it: the same record the Draft
 * stage is given is the one a User can read, so "why did it write that?" is
 * answerable without access to a database. Anything missing from here — bot
 * commits, merge commits, lockfile churn — was excluded when the Digest was
 * built and is not being hidden at the edge.
 *
 * `isQuiet` is Ara's one judgement about the day rather than a fact from the
 * Forge, and it is what decides the shape of the Draft.
 */
export class DigestResponse extends Schema.Class<DigestResponse>("DigestResponse")({
  id: Schema.String,
  runId: Schema.String,
  forge: Forge,
  owner: Schema.String,
  name: Schema.String,
  day: CalendarDay,
  commitCount: Schema.Int,
  commits: Schema.Array(CommitSummary),
  pullRequests: Schema.Array(PullRequestSummary),
  totals: DigestTotals,
  topAreas: Schema.Array(AreaChurn),
  topFiles: Schema.Array(FileChurn),
  isQuiet: Schema.Boolean,
  collectedAt: Schema.DateTimeUtc
}) {}

/**
 * No Digest for this Run. The same answer whether the Run is somebody else's,
 * never existed, or has not collected anything yet — so a 404 confirms nothing.
 */
export class NoSuchDigest extends Schema.TaggedError<NoSuchDigest>()(
  "NoSuchDigest",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 404 })
) {}

/**
 * Digests: what a Run found.
 *
 * A Digest hangs off the Run that produced it rather than having an id a client
 * has to keep, because the Run id is what asking for one hands back. The group
 * sits behind `SessionAuthentication`, so no endpoint here can be reached
 * without a `CurrentUser` to scope it to.
 */
export class DigestsApiGroup extends HttpApiGroup.make("digests")
  .add(
    HttpApiEndpoint.get("read", "/v1/runs/:id/digest")
      .setPath(Schema.Struct({ id: Schema.UUID }))
      .addSuccess(DigestResponse)
      .addError(NoSuchDigest)
      .annotate(OpenApi.Summary, "The Digest a Run collected")
  )
  .middleware(SessionAuthentication)
  .annotate(OpenApi.Description, "What Ara believes happened in a repository, on one day.") {}
