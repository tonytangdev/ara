import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, DateTime, Effect, Fiber, Layer, Option, Ref, Schema, TestClock } from "effect"
import { Repository } from "../../connections/domain/repository.ts"
import { UserId } from "../../connections/domain/user.ts"
import { Digest, DigestTotals, StoredDigest } from "../../digests/domain/digest.ts"
import { ActivityUnavailable } from "../../digests/domain/ports/repo-activity-source.ts"
import { CollectDigest } from "../../digests/index.ts"
import { StoredDraft } from "../../drafts/domain/draft.ts"
import { DraftUnavailable } from "../../drafts/domain/ports/draft-writer.ts"
import { WriteDraft } from "../../drafts/index.ts"
import { CalendarDay, DayWindow } from "../domain/day-window.ts"
import { JobQueue } from "../domain/ports/job-queue.ts"
import { Run, RunId, type RunOutcome, type RunState } from "../domain/run.ts"
import type { RunCost } from "../domain/run-cost.ts"
import { ProcessNextRun } from "./process-next-run.ts"

/**
 * What these tests drive: what a Run does when a stage will not work.
 *
 * Failures are forced at the two stage ports rather than by breaking anything
 * underneath them, and they are the failures those ports really raise —
 * `ActivityUnavailable` and `DraftUnavailable`, carrying the `retryable` flag
 * the adapters set. That is what makes this test survive rate limiting being
 * added inside the GitHub and model adapters: the classification is the
 * adapter's, and what is under test here is what the Run does with it.
 *
 * Nothing waits. The backoff is real and the assertions are about it, so the
 * clock is a `TestClock` that is moved by hand; a test that slept through an
 * exponential backoff would take half a minute and would still prove less.
 */

const A_DAY = "2026-08-22"
const SOMETIME = DateTime.unsafeMake("2026-08-22T09:00:00Z")

const OCTOCAT = UserId.make("00000000-0000-4000-8000-000000000001")
const THE_RUN = RunId.make("00000000-0000-4000-8000-000000000002")
const ARA = new Repository({ forge: "github", owner: "octocat", name: "ara" })

const queuedRun = new Run({
  id: THE_RUN,
  userId: OCTOCAT,
  repoConnectionId: null,
  repository: ARA,
  dayWindow: new DayWindow({
    day: CalendarDay.make(A_DAY),
    timeZone: Schema.decodeSync(DayWindow.fields.timeZone)("Europe/Paris")
  }),
  trigger: "user",
  state: "queued",
  attempts: 0,
  failureReason: null,
  cost: null,
  requestedAt: SOMETIME,
  startedAt: null,
  finishedAt: null
})

/**
 * The queue, in memory: one Run, and the same transitions the Postgres adapter
 * makes. The claim's concurrency is not under test here — that is the
 * Testcontainers test, because only a real database can be got wrong about it.
 */
const jobQueueOver = (state: Ref.Ref<Run>) =>
  Layer.succeed(
    JobQueue,
    JobQueue.of({
      enqueue: () => Ref.get(state),
      claim: Ref.modify(state, (run) =>
        run.state === "queued"
          ? [
              Option.some(new Run({ ...run, state: "collecting", attempts: run.attempts + 1, startedAt: SOMETIME })),
              new Run({ ...run, state: "collecting", attempts: run.attempts + 1, startedAt: SOMETIME })
            ]
          : [Option.none(), run]
      ),
      advance: (_id, next: RunState) => Ref.update(state, (run) => new Run({ ...run, state: next })),
      recordAttempt: (_id, resumeAt: RunState) =>
        Ref.modify(state, (run) => {
          const attempted = new Run({ ...run, state: resumeAt, attempts: run.attempts + 1 })
          return [attempted.attempts, attempted]
        }),
      recordCost: (_id, cost: RunCost) => Ref.update(state, (run) => new Run({ ...run, cost })),
      complete: (_id, outcome: RunOutcome) =>
        Ref.update(
          state,
          (run) =>
            new Run({
              ...run,
              state: outcome.state,
              failureReason: outcome.state === "failed" ? outcome.reason : null,
              finishedAt: SOMETIME
            })
        ),
      requeueInterrupted: Effect.succeed(0)
    })
  )

/** What a stage does on one attempt: the work, or a failure the port describes. */
type Answer<E> = "works" | E

/** The script is consumed one answer per attempt, and the last answer repeats. */
const answerFor = <E>(answers: ReadonlyArray<Answer<E>>, attempt: number): Answer<E> =>
  answers[attempt - 1] ?? answers.at(-1) ?? "works"

const aDigest = new StoredDigest({
  id: "00000000-0000-4000-8000-000000000003",
  runId: THE_RUN,
  digest: new Digest({
    repo: ARA,
    day: CalendarDay.make(A_DAY),
    commitCount: 2,
    commits: [],
    pullRequests: [],
    totals: new DigestTotals({ filesTouched: 3, additions: 40, deletions: 5 }),
    topAreas: [],
    topFiles: [],
    isQuiet: false
  }),
  collectedAt: SOMETIME
})

const aDraft = new StoredDraft({
  id: "00000000-0000-4000-8000-000000000004",
  runId: THE_RUN,
  digestId: aDigest.id,
  shape: "full",
  body: "Spent the day teaching failed Runs to explain themselves.",
  editedBody: null,
  editedAt: null,
  model: "fake/scripted",
  inputTokens: 1_200,
  outputTokens: 300,
  reasoningTokens: 900,
  totalTokens: 1_500,
  costUsd: 0.021,
  generatedAt: SOMETIME
})

/** The collect stage, answering from a script instead of reading a Forge. */
const collectingBy = (answers: ReadonlyArray<Answer<ActivityUnavailable>>) =>
  Layer.effect(
    CollectDigest,
    Effect.map(Ref.make(0), (calls) =>
      CollectDigest.make({
        execute: () =>
          Effect.flatMap(
            Ref.updateAndGet(calls, (made) => made + 1),
            (made) => {
              const answer = answerFor(answers, made)
              return answer === "works" ? Effect.succeed(aDigest) : Effect.fail(answer)
            }
          )
      })
    )
  )

/** The Draft stage, answering from a script instead of calling a model. */
const draftingBy = (answers: ReadonlyArray<Answer<DraftUnavailable>>) =>
  Layer.effect(
    WriteDraft,
    Effect.map(Ref.make(0), (calls) =>
      WriteDraft.make({
        execute: () =>
          Effect.flatMap(
            Ref.updateAndGet(calls, (made) => made + 1),
            (made) => {
              const answer = answerFor(answers, made)
              return answer === "works" ? Effect.succeed(aDraft) : Effect.fail(answer)
            }
          )
      })
    )
  )

/** Two seconds of backoff, doubling, is what the deployed configuration says. */
const TestConfig = Layer.setConfigProvider(
  ConfigProvider.fromMap(
    new Map([
      ["RUN_MAX_ATTEMPTS", "5"],
      ["RUN_RETRY_BASE_DELAY", "2 seconds"]
    ])
  )
)

/**
 * Drive one Run to a standstill and answer with how it ended.
 *
 * The use case runs in its own fiber only so that the clock can be walked
 * forward past every backoff it asks for; nothing here polls, and the fiber is
 * joined rather than waited on.
 */
const runToCompletion = (
  collect: ReadonlyArray<Answer<ActivityUnavailable>>,
  draft: ReadonlyArray<Answer<DraftUnavailable>>
) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(queuedRun)

    const working = yield* Effect.fork(
      Effect.flatMap(ProcessNextRun, (processNextRun) => processNextRun.execute).pipe(
        Effect.provide(
          ProcessNextRun.Default.pipe(
            Layer.provide(Layer.mergeAll(collectingBy(collect), draftingBy(draft), jobQueueOver(state))),
            Layer.provide(TestConfig)
          )
        )
      )
    )

    // Far past the longest run of backoffs five attempts can ask for, so the
    // test never depends on how long any single one was.
    yield* TestClock.adjust("1 hour")

    const claimed = yield* Fiber.join(working)
    assert.isTrue(Option.isSome(claimed), "expected a Run to have been claimed")

    return yield* Ref.get(state)
  })

const rateLimited = new ActivityUnavailable({
  reason: "GitHub could not say what was committed for octocat/ara just now. It may be busy or having trouble.",
  retryable: true
})

const revoked = new ActivityUnavailable({
  reason: "Ara is no longer connected to octocat/ara. Connect the repository again to write about it.",
  retryable: false
})

const wroteNothing = new DraftUnavailable({
  reason: "The model answered without writing anything.",
  retryable: true
})

describe("A Run whose stage fails and then works", () => {
  it.effect("recovers on its own, and says how many attempts it took", () =>
    Effect.gen(function* () {
      const run = yield* runToCompletion([rateLimited, rateLimited, "works"], ["works"])

      assert.strictEqual(run.state, "succeeded")
      assert.isNull(run.failureReason)
      assert.strictEqual(run.attempts, 3)
    })
  )

  it.effect("retries the Draft stage without reading the Forge again", () =>
    Effect.gen(function* () {
      // The collect stage answers exactly once. If a retry of the Draft stage
      // went back through it, the second answer would be the script running out
      // and the Run would not succeed.
      const run = yield* runToCompletion(["works", rateLimited], [wroteNothing, "works"])

      assert.strictEqual(run.state, "succeeded")
      assert.strictEqual(run.attempts, 2)
    })
  )
})

describe("A Run that keeps failing", () => {
  it.effect("stops after five attempts, in a state it never leaves", () =>
    Effect.gen(function* () {
      const run = yield* runToCompletion([rateLimited], ["works"])

      assert.strictEqual(run.state, "failed")
      assert.isTrue(run.isFinished)
      assert.strictEqual(run.attempts, 5)
      // The User is told what happened, and that Ara stopped rather than gave up quietly.
      assert.include(run.failureReason ?? "", "GitHub could not say")
      assert.include(run.failureReason ?? "", "5 times")
    })
  )

  it.effect("stops after five attempts at the model too", () =>
    Effect.gen(function* () {
      const run = yield* runToCompletion(["works"], [wroteNothing])

      assert.strictEqual(run.state, "failed")
      assert.strictEqual(run.attempts, 5)
      assert.include(run.failureReason ?? "", "The model answered without writing anything.")
    })
  )
})

describe("A Run that cannot work however often it is tried", () => {
  it.effect("fails at once, with the reason the port gave, and never waits", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(queuedRun)

      // No clock is moved at all here: a terminal failure that waited would
      // hang this test, which is the assertion.
      yield* Effect.flatMap(ProcessNextRun, (processNextRun) => processNextRun.execute).pipe(
        Effect.provide(
          ProcessNextRun.Default.pipe(
            Layer.provide(Layer.mergeAll(collectingBy([revoked]), draftingBy(["works"]), jobQueueOver(state))),
            Layer.provide(TestConfig)
          )
        )
      )

      const run = yield* Ref.get(state)
      assert.strictEqual(run.state, "failed")
      assert.strictEqual(run.attempts, 1)
      assert.strictEqual(run.failureReason, revoked.reason)
    })
  )
})

describe("A Run that breaks rather than fails", () => {
  it.effect("still ends explained, rather than stranded in flight", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(queuedRun)

      const working = yield* Effect.fork(
        Effect.flatMap(ProcessNextRun, (processNextRun) => processNextRun.execute).pipe(
          Effect.provide(
            ProcessNextRun.Default.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(
                    CollectDigest,
                    CollectDigest.make({ execute: () => Effect.dieMessage("the connection pool is on fire") })
                  ),
                  draftingBy(["works"]),
                  jobQueueOver(state)
                )
              ),
              Layer.provide(TestConfig)
            )
          )
        )
      )

      yield* TestClock.adjust("1 hour")
      yield* Fiber.join(working)

      const run = yield* Ref.get(state)
      assert.strictEqual(run.state, "failed")
      assert.strictEqual(run.attempts, 5)
      assert.include(run.failureReason ?? "", "Something went wrong inside Ara")
    })
  )
})

describe("An empty queue", () => {
  it.effect("is not a Run, and not a failure", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(new Run({ ...queuedRun, state: "succeeded" }))

      const claimed = yield* Effect.flatMap(ProcessNextRun, (processNextRun) => processNextRun.execute).pipe(
        Effect.provide(
          ProcessNextRun.Default.pipe(
            Layer.provide(Layer.mergeAll(collectingBy(["works"]), draftingBy(["works"]), jobQueueOver(state))),
            Layer.provide(TestConfig)
          )
        )
      )

      assert.isTrue(Option.isNone(claimed))
    })
  )
})
