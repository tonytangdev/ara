import { Effect, Layer, Option } from "effect"
import { WorkerConfig } from "../../../config.ts"
import { ProcessNextRun } from "../../application/process-next-run.ts"
import { RequeueInterruptedRuns } from "../../application/requeue-interrupted-runs.ts"

/**
 * The background worker: a thin loop around `ProcessNextRun`, and nothing else.
 *
 * All the interesting behaviour is in the use case, deliberately. What is left
 * here is scheduling — claim, and when there is nothing to claim, wait — which
 * is the part no test should ever have to wait for.
 *
 * It is a scoped daemon fiber rather than a `setInterval` or a detached
 * `Effect.fork`: the fiber belongs to the layer's scope, so it starts when the
 * application is built and is interrupted when the application shuts down. That
 * is what "stops cleanly" means here — there is no separate stop signal to
 * remember to send, and no fiber left running after the layer is finalized.
 *
 * One Run at a time is processed uninterruptibly, so a Run that has been
 * claimed is never abandoned halfway through by a deploy; the interruption
 * lands in the sleep instead. Anything a hard kill does leave behind is picked
 * up by `RequeueInterruptedRuns` when the next process boots.
 */
export const RunWorkerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const { enabled, pollInterval } = yield* WorkerConfig

    if (!enabled) {
      return yield* Effect.logInfo("Run worker is disabled; queued Runs will stay queued")
    }

    const processNextRun = yield* ProcessNextRun
    const requeueInterruptedRuns = yield* RequeueInterruptedRuns

    yield* requeueInterruptedRuns.execute

    const loop = Effect.gen(function* () {
      const processed = yield* Effect.uninterruptible(processNextRun.execute)

      if (Option.isNone(processed)) {
        yield* Effect.sleep(pollInterval)
      }
    }).pipe(Effect.forever)

    yield* loop.pipe(
      Effect.onInterrupt(() => Effect.logInfo("Run worker stopped")),
      Effect.forkScoped
    )

    yield* Effect.logInfo("Run worker started").pipe(Effect.annotateLogs({ pollInterval: `${pollInterval}` }))
  })
)
