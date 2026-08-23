import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "@effect/platform"
import { Schema } from "effect"
import { NoSuchRepoConnection, SessionAuthentication } from "../connections/api.ts"
import { Forge } from "../connections/domain/forge.ts"
import { TimeZone } from "../connections/domain/time-zone.ts"
import { CalendarDay } from "./domain/day-window.ts"
import type { Run } from "./domain/run.ts"
import { RunState, Trigger } from "./domain/run.ts"
import { RunCost } from "./domain/run-cost.ts"

/**
 * What a client asks for: a calendar day, and nothing else. The timezone is
 * pointedly absent — it belongs to the User, not to the request, so the same
 * `day` means the same span of time however the caller reached the API.
 */
export class RequestRunRequest extends Schema.Class<RequestRunRequest>("RequestRunRequest")({
  day: CalendarDay
}) {}

/**
 * A Run as the API tells it.
 *
 * The Day Window is reported three ways — the day, the zone it was read in, and
 * the instants that produced — because "a calendar day in your timezone" is a
 * claim a client should be able to check rather than take on trust.
 *
 * `cost` is here rather than only on the Draft because a User polling a Run is
 * already holding the id, and what a habit costs should be one request away
 * from the thing they asked for.
 */
export class RunResponse extends Schema.Class<RunResponse>("RunResponse")({
  id: Schema.String,
  state: RunState,
  trigger: Trigger,
  forge: Forge,
  owner: Schema.String,
  name: Schema.String,
  /** Null once the Repo Connection this Run was authorized by has been removed. */
  repoConnectionId: Schema.NullOr(Schema.String),
  day: CalendarDay,
  timeZone: TimeZone,
  windowStartsAt: Schema.DateTimeUtc,
  windowEndsAt: Schema.DateTimeUtc,
  attempts: Schema.Int,
  /**
   * The Digest this Run is writing from, when it is a regeneration of an
   * earlier Draft. Null on an ordinary Run, which collects its own. It is the
   * one thing that distinguishes "writing about a day for the first time" from
   * "writing about it again", and a client showing a list of Runs needs it to
   * explain why two Runs are about the same day.
   */
  sourceDigestId: Schema.NullOr(Schema.String),
  /**
   * What this Run spent, or null until it has spent anything. Reported on the
   * Run itself because the Run id is what a User holds: asking what yesterday's
   * post cost should not mean finding a Draft id first.
   */
  cost: Schema.NullOr(RunCost),
  failureReason: Schema.NullOr(Schema.String),
  requestedAt: Schema.DateTimeUtc,
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  finishedAt: Schema.NullOr(Schema.DateTimeUtc)
}) {}

/**
 * A Run as the wire sees it.
 *
 * It lives beside the schema rather than in the runs handlers because two
 * modules answer with a Run: the runs module, and the drafts module when a
 * regeneration is asked for. One mapping means the two answers cannot drift
 * into disagreeing about what a Run looks like.
 */
export const runResponse = (run: Run): RunResponse =>
  new RunResponse({
    id: run.id,
    state: run.state,
    trigger: run.trigger,
    forge: run.repository.forge,
    owner: run.repository.owner,
    name: run.repository.name,
    repoConnectionId: run.repoConnectionId,
    day: run.dayWindow.day,
    timeZone: run.dayWindow.timeZone,
    windowStartsAt: run.dayWindow.startsAt,
    windowEndsAt: run.dayWindow.endsAt,
    attempts: run.attempts,
    sourceDigestId: run.sourceDigestId,
    cost: run.cost,
    failureReason: run.failureReason,
    requestedAt: run.requestedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt
  })

/**
 * No such Run for the caller. The same answer whether it never existed or
 * belongs to somebody else, so a 404 confirms nothing.
 */
export class NoSuchRun extends Schema.TaggedError<NoSuchRun>()(
  "NoSuchRun",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 404 })
) {}

/** The day cannot be turned into a Day Window in the User's timezone. */
export class UnusableDayWindow extends Schema.TaggedError<UnusableDayWindow>()(
  "UnusableDayWindow",
  { reason: Schema.String },
  HttpApiSchema.annotations({ status: 422 })
) {}

/**
 * Runs: asking for one, and watching it move.
 *
 * The whole group sits behind `SessionAuthentication`, so no endpoint here can
 * be reached without a `CurrentUser` to scope it to. Requesting a Run hangs off
 * the Repo Connection's own path because owning that connection is precisely
 * what entitles somebody to a Run for that repository.
 */
export class RunsApiGroup extends HttpApiGroup.make("runs")
  .add(
    HttpApiEndpoint.post("request", "/v1/repo-connections/:id/runs")
      .setPath(Schema.Struct({ id: Schema.UUID }))
      .setPayload(RequestRunRequest)
      // 202, not 201: the Run exists, the work has not happened yet.
      .addSuccess(RunResponse, { status: 202 })
      // Not the caller's connection, or not a connection at all: the same 404
      // asking for it directly would give, for the same reason.
      .addError(NoSuchRepoConnection)
      .addError(UnusableDayWindow)
      .annotate(OpenApi.Summary, "Request a Run for a Day Window")
  )
  .add(
    HttpApiEndpoint.get("read", "/v1/runs/:id")
      .setPath(Schema.Struct({ id: Schema.UUID }))
      .addSuccess(RunResponse)
      .addError(NoSuchRun)
      .annotate(OpenApi.Summary, "What stage a Run is at")
  )
  .add(
    HttpApiEndpoint.get("list", "/v1/runs")
      .addSuccess(Schema.Array(RunResponse))
      .annotate(OpenApi.Summary, "The caller's recent Runs")
  )
  .middleware(SessionAuthentication)
  .annotate(OpenApi.Description, "Turning a Day Window into a Draft, one Run at a time.") {}
