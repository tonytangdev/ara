import { Effect, Option } from "effect"
import { RepoConnectionRepository } from "../../connections/domain/ports/repo-connection-repository.ts"
import { type RepoConnectionId, RepoConnectionNotFound } from "../../connections/domain/repo-connection.ts"
import type { User } from "../../connections/domain/user.ts"
import { type InvalidDayWindow, makeDayWindow } from "../domain/day-window.ts"
import { JobQueue } from "../domain/ports/job-queue.ts"
import type { Run } from "../domain/run.ts"

/**
 * Driving (inbound) port: ask for a Run.
 *
 * Returns as soon as the Run is durable and without doing any of the work — the
 * caller gets an id to poll, and nothing holds their connection open while Ara
 * reads a Forge and calls a model.
 *
 * Two rules live here rather than at the edge. The Repo Connection has to be
 * the caller's own, because owning the connection is what entitles somebody to
 * Digests and Drafts for that repository. And the Day Window is built from the
 * *User's* timezone, never from the request: the client says which calendar day
 * it wants, and what that day spans is a fact about the person asking.
 */
export class RequestRun extends Effect.Service<RequestRun>()("application/runs/RequestRun", {
  effect: Effect.gen(function* () {
    const connections = yield* RepoConnectionRepository
    const queue = yield* JobQueue

    const execute = (
      user: User,
      connectionId: RepoConnectionId,
      day: string
    ): Effect.Effect<Run, RepoConnectionNotFound | InvalidDayWindow> =>
      Effect.gen(function* () {
        const connection = yield* Effect.flatMap(
          connections.findOwnedBy(connectionId, user.id),
          Option.match({
            onNone: () => Effect.fail(new RepoConnectionNotFound()),
            onSome: Effect.succeed
          })
        )

        const dayWindow = yield* makeDayWindow(day, user.timeZone)

        const run = yield* queue.enqueue({ userId: user.id, connection, dayWindow, trigger: "user" })

        yield* Effect.logInfo("Requested a Run").pipe(
          Effect.annotateLogs({
            userId: user.id,
            runId: run.id,
            repository: `${run.repository.owner}/${run.repository.name}`,
            day: run.dayWindow.day,
            timeZone: run.dayWindow.timeZone,
            state: run.state
          })
        )

        return run
      })

    return { execute } as const
  })
}) {}
