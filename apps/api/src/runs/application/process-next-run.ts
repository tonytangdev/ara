import { Effect, Option, Random } from "effect"
import { RunConfig } from "../../config.ts"
import { CollectDigest } from "../../digests/index.ts"
import { WriteDraft } from "../../drafts/index.ts"
import { JobQueue } from "../domain/ports/job-queue.ts"
import { backoffFor, hasAttemptsLeft } from "../domain/retry-policy.ts"
import type { Run } from "../domain/run.ts"
import { failureIn, finalReason, type RunFailure, type RunStage, unexpectedFailureIn } from "../domain/run-failure.ts"

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
 *
 * Recovery lives here too, and only here. Each driven port classifies its own
 * failures — only the adapter that made the call can tell a rate limit from a
 * revoked key — and this use case is what acts on the classification: retry a
 * transient failure, stop on a terminal one, and either way end with something
 * the User can read.
 */
export class ProcessNextRun extends Effect.Service<ProcessNextRun>()("application/runs/ProcessNextRun", {
  effect: Effect.gen(function* () {
    const { maxAttempts, retryBaseDelay, retryMaxDelay } = yield* RunConfig
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
      collectDigest
        .execute({
          runId: run.id,
          userId: run.userId,
          repoConnectionId: run.repoConnectionId,
          repository: run.repository,
          dayWindow: run.dayWindow
        })
        .pipe(Effect.mapError((failure) => failureIn("collecting", failure)))

    const draft = (run: Run) =>
      writeDraft
        .execute({ runId: run.id, userId: run.userId })
        .pipe(Effect.mapError((failure) => failureIn("drafting", failure)))

    /**
     * One attempt at a Run, resuming at the stage the last attempt stopped in.
     *
     * A retry of the Draft stage does not read the Forge again, which is the
     * whole point of persisting the Digest between the stages: a model that
     * answers with nothing costs one more model call and no more Forge calls.
     * Starting from the collect stage is safe too — collecting twice leaves one
     * Digest, and a Run that already has a Draft is left alone — because a Run
     * is claimed more than once whenever a deploy interrupts one.
     */
    const attempt = (run: Run, from: RunStage) =>
      Effect.gen(function* () {
        const where = {
          runId: run.id,
          userId: run.userId,
          repository: `${run.repository.owner}/${run.repository.name}`,
          day: run.dayWindow.day
        }

        if (from === "collecting") {
          const { digest } = yield* collect(run)

          if (digest.isEmpty) {
            yield* queue.complete(run.id, { state: "quiet" })
            yield* Effect.logInfo("Run found a day with nothing in it").pipe(Effect.annotateLogs(where))
            return
          }

          yield* queue.advance(run.id, "drafting")
        }

        // The Draft says which shape it took, so an attempt that resumed at the
        // Draft stage — after a retry or a deploy — still ends in `quiet` for a
        // light day without reading the Digest back to ask.
        const written = yield* draft(run)
        const isQuiet = written.shape === "quiet"

        yield* queue.complete(run.id, { state: isQuiet ? "quiet" : "succeeded" })

        yield* Effect.logInfo(isQuiet ? "Run wrote a Quiet Draft" : "Run succeeded").pipe(Effect.annotateLogs(where))
      }).pipe(
        // A defect is the one failure no port described, so it is the one
        // failure with nothing to tell the User. It is logged in full and
        // turned into a Run failure that says as much, rather than being left
        // to escape and strand the Run in flight. Interruption is not a defect
        // and passes straight through: a deploy is not a Run failing.
        Effect.catchAllDefect((defect) =>
          Effect.logError("Run broke", defect).pipe(
            Effect.annotateLogs({ runId: run.id, stage: from }),
            Effect.zipRight(Effect.fail(unexpectedFailureIn(from)))
          )
        )
      )

    const giveUp = (run: Run, failure: RunFailure, attempts: number) =>
      Effect.logWarning("Run failed").pipe(
        Effect.annotateLogs({
          runId: run.id,
          stage: failure.stage,
          kind: failure.kind,
          attempts,
          reason: failure.reason
        }),
        Effect.zipRight(queue.complete(run.id, { state: "failed", reason: finalReason(failure, attempts) }))
      )

    /**
     * Attempt, and on a transient failure wait and attempt again — up to the
     * ceiling, after which the Run lands in `failed` and stops.
     *
     * The Run stays in flight for the whole of the backoff rather than going
     * back on the queue, because this worker has not let go of it and a Run
     * that looked queued here would be claimed by a second worker mid-wait.
     * The sleep is interruptible on purpose: a deploy that lands in a backoff
     * should stop rather than wait it out, and the Run it leaves mid-flight is
     * exactly what the next boot requeues.
     */
    const process = (run: Run) => {
      const go = (from: RunStage, attempts: number): Effect.Effect<void> =>
        attempt(run, from).pipe(
          Effect.catchAll((failure) =>
            failure.kind === "terminal" || !hasAttemptsLeft(attempts, maxAttempts)
              ? giveUp(run, failure, attempts)
              : Effect.gen(function* () {
                  const delay = backoffFor(attempts, retryBaseDelay, retryMaxDelay, yield* Random.next)

                  yield* Effect.logInfo("Run failed and will be tried again").pipe(
                    Effect.annotateLogs({
                      runId: run.id,
                      stage: failure.stage,
                      attempts,
                      in: `${delay}`,
                      reason: failure.reason
                    })
                  )

                  yield* Effect.interruptible(Effect.sleep(delay))

                  return yield* go(failure.stage, yield* queue.recordAttempt(run.id, failure.stage))
                })
          )
        )

      // The claim has already counted this attempt, so the Run arrives holding
      // its own attempt number — including the ones a crash and a requeue made
      // in an earlier process. A Run that has been picked up and dropped five
      // times has had its five attempts wherever they happened.
      return go("collecting", run.attempts)
    }

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
