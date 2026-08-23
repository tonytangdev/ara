import { Effect } from "effect"
import { JobQueue } from "../domain/ports/job-queue.ts"

/**
 * Driving (inbound) port: hand back the Runs a stopped process was holding.
 *
 * Run once as the worker starts. A Run that a deploy interrupted is sitting in
 * `collecting` or `drafting` with nobody working on it, and no claim will ever
 * look at it again; this is what makes restarting recover rather than silently
 * lose work. It is safe precisely because processing is idempotent, which is
 * what the persisted Digest boundary buys (ADR-0002).
 */
export class RequeueInterruptedRuns extends Effect.Service<RequeueInterruptedRuns>()(
  "application/runs/RequeueInterruptedRuns",
  {
    effect: Effect.gen(function* () {
      const queue = yield* JobQueue

      const execute: Effect.Effect<number> = Effect.tap(queue.requeueInterrupted, (requeued) =>
        requeued === 0
          ? Effect.logDebug("No interrupted Runs to pick up")
          : Effect.logInfo(`Picked up ${requeued} Run(s) interrupted by an earlier shutdown`)
      )

      return { execute } as const
    })
  }
) {}
