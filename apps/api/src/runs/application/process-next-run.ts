import { Cause, Effect, Option } from "effect"
import { CollectDigest } from "../../digests/index.ts"
import { WriteDraft } from "../../drafts/index.ts"
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
    const collectDigest = yield* CollectDigest
    const writeDraft = yield* WriteDraft

    /**
     * The pipeline: two stages with a persisted Digest between them (ADR-0002),
     * each one visible to a User polling the Run.
     *
     * Each stage is handed the facts it needs rather than the Run itself: the
     * digests module answers "what happened in this repository, that day" and
     * the drafts module answers "write the post for this Run's Digest", and
     * neither owes the runs module anything beyond that.
     *
     * The Draft stage reads the Digest the collect stage persisted rather than
     * being passed it, which is what makes the boundary real: a Run reclaimed
     * after a deploy starts the second stage from storage, and regenerating a
     * Draft later (#11) takes the same path without a Forge call.
     *
     * The Quiet Day is decided before either stage runs: `isQuiet` is a fact
     * about the Digest by the time the collect stage finishes, so the pipeline
     * only reads it. A light day still gets a Draft — a Quiet Draft, shorter and
     * told it may say the day was light — and ends in `quiet`, which is a
     * successful outcome and not a failure. A day with no Activity at all ends
     * there too, and never reaches the model: there is nothing to write from,
     * and asking anyway is asking for a day that did not happen.
     */
    const collect = (run: Run) =>
      collectDigest.execute({
        runId: run.id,
        userId: run.userId,
        repoConnectionId: run.repoConnectionId,
        repository: run.repository,
        dayWindow: run.dayWindow
      })

    const draft = (run: Run) => writeDraft.execute({ runId: run.id, userId: run.userId })

    const process = (run: Run) =>
      Effect.gen(function* () {
        const { digest } = yield* collect(run)

        const where = {
          runId: run.id,
          userId: run.userId,
          repository: `${run.repository.owner}/${run.repository.name}`,
          day: run.dayWindow.day
        }

        if (digest.isEmpty) {
          yield* queue.complete(run.id, { state: "quiet" })
          yield* Effect.logInfo("Run found a day with nothing in it").pipe(Effect.annotateLogs(where))
          return
        }

        yield* queue.advance(run.id, "drafting")
        yield* draft(run)
        yield* queue.complete(run.id, { state: digest.isQuiet ? "quiet" : "succeeded" })

        yield* Effect.logInfo(digest.isQuiet ? "Run wrote a Quiet Draft" : "Run succeeded").pipe(
          Effect.annotateLogs(where)
        )
      }).pipe(
        // The failures that already know how to explain themselves: the
        // repository could not be read, or the model wrote nothing. Why is
        // something the User can usually act on, so it is told to them rather
        // than logged at them.
        Effect.catchTags({
          ActivityUnavailable: (failure) =>
            Effect.logWarning("Run failed to collect Activity").pipe(
              Effect.annotateLogs({ runId: run.id, reason: failure.reason }),
              Effect.zipRight(queue.complete(run.id, { state: "failed", reason: failure.reason }))
            ),
          // The model gave nothing usable, and by the time it reaches here the
          // retryable ones have already been retried. A Run fails without a
          // Draft rather than succeeding with an empty one.
          DraftUnavailable: (failure) =>
            Effect.logWarning("Run failed to write a Draft").pipe(
              Effect.annotateLogs({ runId: run.id, reason: failure.reason, retryable: failure.retryable }),
              Effect.zipRight(queue.complete(run.id, { state: "failed", reason: failure.reason }))
            )
        }),
        // A Run that blows up has to stop being in flight, or it is unclaimable
        // and unexplainable at once. What a User is told about the rest is
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
