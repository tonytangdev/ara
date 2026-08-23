import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { NoSuchRepoConnection } from "../../../connections/api.ts"
import { CurrentUser } from "../../../connections/domain/current-user.ts"
import type { RepoConnectionId } from "../../../connections/domain/repo-connection.ts"
import { AraApi } from "../../../http/api.ts"
import { NoSuchRun, RunResponse, UnusableDayWindow } from "../../api.ts"
import { DescribeRun } from "../../application/describe-run.ts"
import { ListRuns } from "../../application/list-runs.ts"
import { RequestRun } from "../../application/request-run.ts"
import type { Run, RunId } from "../../domain/run.ts"

const toResponse = (run: Run) =>
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
    failureReason: run.failureReason,
    requestedAt: run.requestedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt
  })

/**
 * Driving (inbound) adapter for Runs.
 *
 * Requesting a Run answers 202 the moment the Run is durable: no handler here
 * ever waits for work to happen, which is the whole reason a Run is a row and
 * not a long-lived request.
 *
 * Every handler takes its User from `CurrentUser` and never from anything the
 * caller sent, so scoping is not something a handler can forget. "Not yours"
 * and "does not exist" arrive here as the same domain failure and leave as the
 * same 404.
 */
export const RunsHandlersLive = HttpApiBuilder.group(AraApi, "runs", (handlers) =>
  handlers
    .handle("request", ({ path, payload }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const request = yield* RequestRun

        const run = yield* request.execute(user, path.id as RepoConnectionId, payload.day).pipe(
          Effect.catchTags({
            RepoConnectionNotFound: () => new NoSuchRepoConnection({ message: "No such Repo Connection" }),
            InvalidDayWindow: (failure) => new UnusableDayWindow({ reason: failure.reason })
          })
        )

        return toResponse(run)
      })
    )
    .handle("read", ({ path }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const describe = yield* DescribeRun

        const run = yield* describe
          .execute(user, path.id as RunId)
          .pipe(Effect.mapError(() => new NoSuchRun({ message: "No such Run" })))

        return toResponse(run)
      })
    )
    .handle("list", () =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const list = yield* ListRuns

        return (yield* list.execute(user)).map(toResponse)
      })
    )
)
