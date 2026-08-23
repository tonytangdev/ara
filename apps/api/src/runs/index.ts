import { Layer } from "effect"
import { RepoConnectionRepositoryLive } from "../connections/index.ts"
import { CollectDigestLive } from "../digests/index.ts"
import { WriteDraftLive } from "../drafts/index.ts"
import { DescribeRun } from "./application/describe-run.ts"
import { ListRuns } from "./application/list-runs.ts"
import { ProcessNextRun } from "./application/process-next-run.ts"
import { RequestRun } from "./application/request-run.ts"
import { RequeueInterruptedRuns } from "./application/requeue-interrupted-runs.ts"
import { RunsHandlersLive } from "./infrastructure/http/runs-handlers.ts"
import { PgJobQueueLive } from "./infrastructure/persistence/pg-job-queue.ts"
import { PgRunRepositoryLive } from "./infrastructure/persistence/pg-run-repository.ts"
import { RunWorkerLive } from "./infrastructure/worker/run-worker.ts"

/** The queue and the Runs in it, over Postgres (ADR-0001). */
const DrivenLive = Layer.mergeAll(PgJobQueueLive, PgRunRepositoryLive, RepoConnectionRepositoryLive)

/**
 * The runs module's public face. Nothing outside this folder should import
 * anything deeper than these three exports:
 *
 * - `./api.ts` — the HTTP contract this module contributes to the API surface.
 * - `RunsLive` — the HTTP half of the module, fully wired.
 * - `RunsWorkerLive` — the background half.
 *
 * They are two layers rather than one because they are two deployables in
 * waiting: for the MVP the composition root merges both into a single launch,
 * and splitting them across machines later is a change to that root and to
 * nothing else. Merged into one launch they share a `SqlClient` — and one
 * connection pool — through layer memoization, because both leave it as a
 * requirement for the composition root to satisfy.
 */
export const RunsLive = RunsHandlersLive.pipe(
  Layer.provide(Layer.mergeAll(RequestRun.Default, DescribeRun.Default, ListRuns.Default)),
  Layer.provide(DrivenLive)
)

/** The worker: the same use cases, driven by a loop instead of by HTTP. */
export const RunsWorkerLive = RunWorkerLive.pipe(
  Layer.provide(Layer.mergeAll(ProcessNextRun.Default, RequeueInterruptedRuns.Default)),
  // Each stage of a Run belongs to the module that owns it, which is why they
  // arrive here as wired layers rather than as a GitHub client, a model
  // provider and two tables.
  Layer.provide(Layer.mergeAll(CollectDigestLive, WriteDraftLive)),
  Layer.provide(DrivenLive)
)

export { RunsApiGroup } from "./api.ts"
export { ProcessNextRun } from "./application/process-next-run.ts"
export { DayWindow, makeDayWindow } from "./domain/day-window.ts"
export { Run, RunId } from "./domain/run.ts"
