import { Cause, Effect, Option } from "effect"
import { JobQueue } from "../domain/ports/job-queue.ts"
import type { Run } from "../domain/run.ts"

/**
 * Driving (inbound) port: claim the next queued Run and take it as far as it
 * goes. Answers with the Run it worked on, or `none` when the queue is empty.
 *
 * This is the worker's whole unit of work, and it is a use case rather than a
 * loop for a reason: the background fiber is a thin loop around this, and every
 * test drives *this* directly instead of forking a fiber and polling for it to
 * notice. A test that has to wait for a poll interval is a test that goes flaky
 * on a slow machine.
 *
 * Claiming is what makes two workers safe, not a lock held here: `JobQueue.claim`
 * hands a Run to at most one caller and marks it as taken in the same breath
 * (ADR-0001).
 */
export class ProcessNextRun extends Effect.Service<ProcessNextRun>()("application/runs/ProcessNextRun", {
  effect: Effect.gen(function* () {
    const queue = yield* JobQueue

    /**
     * The pipeline, deliberately stubbed.
     *
     * Collecting a Digest (#6) and writing a Draft (#7) replace the bodies of
     * these two stages. What is real already is the shape they hang off: two
     * stages with a persisted boundary between them (ADR-0002), each one
     * visible to a User polling the Run.
     */
    const collect = (run: Run) =>
      Effect.logDebug("Collecting Activity (stubbed)").pipe(Effect.annotateLogs({ runId: run.id }))
    const draft = (run: Run) =>
      Effect.logDebug("Writing a Draft (stubbed)").pipe(Effect.annotateLogs({ runId: run.id }))

    const process = (run: Run) =>
      Effect.gen(function* () {
        yield* collect(run)
        yield* queue.advance(run.id, "drafting")
        yield* draft(run)
        yield* queue.complete(run.id, { state: "succeeded" })

        yield* Effect.logInfo("Run succeeded").pipe(
          Effect.annotateLogs({
            runId: run.id,
            userId: run.userId,
            repository: `${run.repository.owner}/${run.repository.name}`,
            day: run.dayWindow.day
          })
        )
      }).pipe(
        // A Run that blows up has to stop being in flight, or it is unclaimable
        // and unexplainable at once. What a User is told about the failure is
        // still thin here; #12 is where a failure learns to explain itself.
        Effect.catchAllCause((cause) =>
          // Being interrupted is not the Run failing. The shutdown is what
          // happened, and the Run is left in flight for the next boot to
          // requeue rather than being reported to its User as a failure.
          Cause.isInterruptedOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logError("Run failed", cause).pipe(
                Effect.annotateLogs({ runId: run.id }),
                Effect.zipRight(queue.complete(run.id, { state: "failed", reason: "The Run did not finish" }))
              )
        )
      )

    const execute: Effect.Effect<Option.Option<Run>> = Effect.gen(function* () {
      const claimed = yield* queue.claim

      return yield* Option.match(claimed, {
        onNone: () => Effect.succeedNone,
        onSome: (run) => Effect.as(process(run), Option.some(run))
      })
    })

    return { execute } as const
  })
}) {}
