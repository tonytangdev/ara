import { AiError, LanguageModel, Response } from "@effect/ai"
import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Fiber, Layer, Option, Stream, TestClock } from "effect"
import { Repository } from "../../../connections/domain/repository.ts"
import { CommitSummary, Digest, DigestTotals } from "../../../digests/domain/digest.ts"
import { CalendarDay } from "../../../runs/domain/day-window.ts"
import { DraftWriter } from "../../domain/ports/draft-writer.ts"
import { LanguageModelDraftWriterLive } from "./language-model-draft-writer.ts"

const A_DAY = new Digest({
  repo: new Repository({ forge: "github", owner: "octocat", name: "ara" }),
  day: CalendarDay.make("2026-08-22"),
  commitCount: 1,
  commits: [new CommitSummary({ subject: "Add the collect stage", files: ["src/digests/collect.ts"] })],
  pullRequests: [],
  totals: new DigestTotals({ filesTouched: 1, additions: 80, deletions: 4 }),
  topAreas: [],
  topFiles: [],
  isQuiet: false
})

/**
 * Prices worth doing arithmetic with rather than the real ones: a dollar per
 * million in, ten per million out, so a wrong sum is visible at a glance.
 */
const TestConfig = Layer.setConfigProvider(
  ConfigProvider.fromMap(
    new Map([
      ["DRAFT_MODEL", "moonshotai/kimi-k3"],
      ["MODEL_INPUT_USD_PER_MILLION_TOKENS", "1"],
      ["MODEL_OUTPUT_USD_PER_MILLION_TOKENS", "10"]
    ])
  )
)

/**
 * The shape a reasoning model's bill actually takes: the thinking is counted
 * inside the output tokens, and reported apart from them so it can be seen.
 */
const usage = { inputTokens: 1_200, outputTokens: 3_000, reasoningTokens: 2_700, totalTokens: 4_200 }

/**
 * A model that answers with exactly the parts it is given.
 *
 * The interesting scripts are the ones that are not errors: a 200 carrying
 * reasoning and nothing else is what the prototype saw once in twenty-four
 * calls, and it is the case this adapter exists to catch.
 */
const modelAnswering = (parts: ReadonlyArray<Response.AnyPart>) =>
  Layer.succeed(LanguageModel.LanguageModel, {
    generateText: () => Effect.succeed(new LanguageModel.GenerateTextResponse(parts as Array<never>)),
    generateObject: () => Effect.dieMessage("a Draft is prose, not an object"),
    streamText: () => Stream.dieMessage("a Draft is not streamed")
  } as unknown as LanguageModel.Service)

/** A model that fails the way the provider's client does, so the mapping is driven and not guessed. */
const modelFailingWith = (error: AiError.AiError) =>
  Layer.succeed(LanguageModel.LanguageModel, {
    generateText: () => Effect.fail(error),
    generateObject: () => Effect.dieMessage("a Draft is prose, not an object"),
    streamText: () => Stream.dieMessage("a Draft is not streamed")
  } as unknown as LanguageModel.Service)

/** A provider that accepted the request and then said nothing, ever. */
const modelThatNeverAnswers = Layer.succeed(LanguageModel.LanguageModel, {
  generateText: () => Effect.never,
  generateObject: () => Effect.dieMessage("a Draft is prose, not an object"),
  streamText: () => Stream.dieMessage("a Draft is not streamed")
} as unknown as LanguageModel.Service)

const writeDraftFailingWith = (error: AiError.AiError) =>
  Effect.flatMap(DraftWriter, (writer) => Effect.either(writer.writeDraft({ digest: A_DAY }))).pipe(
    Effect.provide(LanguageModelDraftWriterLive.pipe(Layer.provide(modelFailingWith(error)), Layer.provide(TestConfig)))
  )

const writeDraftWith = (parts: ReadonlyArray<Response.AnyPart>) =>
  Effect.flatMap(DraftWriter, (writer) => Effect.either(writer.writeDraft({ digest: A_DAY }))).pipe(
    Effect.provide(LanguageModelDraftWriterLive.pipe(Layer.provide(modelAnswering(parts)), Layer.provide(TestConfig)))
  )

describe("Writing a Draft with a language model", () => {
  it.effect("keeps the prose, the model that wrote it and what it cost", () =>
    Effect.gen(function* () {
      const written = yield* writeDraftWith([
        Response.makePart("response-metadata", {
          id: Option.some("gen-1"),
          modelId: Option.some("moonshotai/kimi-k3"),
          timestamp: Option.none()
        }),
        Response.makePart("reasoning", { text: "The day was mostly the collect stage." }),
        Response.makePart("text", { text: "  Spent the day on the collect stage.  " }),
        Response.makePart("finish", { reason: "stop", usage })
      ])

      assert.isTrue(written._tag === "Right")
      if (written._tag !== "Right") return

      assert.strictEqual(written.right.body, "Spent the day on the collect stage.")
      assert.strictEqual(written.right.model, "moonshotai/kimi-k3")
      assert.strictEqual(written.right.inputTokens, 1_200)
      assert.strictEqual(written.right.outputTokens, 3_000)
      // The number the whole ticket is about: nine tenths of what was generated
      // was thinking, and on this model thinking is most of the bill.
      assert.strictEqual(written.right.reasoningTokens, 2_700)
      // Not the sum of input and output: the provider's own total.
      assert.strictEqual(written.right.totalTokens, 4_200)
      // 1,200 in at $1/M and 3,000 out at $10/M. The reasoning tokens are not
      // added again — they are already inside the output figure, and charging
      // for them twice would overstate the largest number on the bill.
      assert.strictEqual(written.right.costUsd, 0.0312)
    })
  )

  /**
   * The rule from the prototype. The response is a perfectly good 200 — it just
   * has no message content, only reasoning. A naive adapter persists an empty
   * Draft; this one fails, and says the failure is worth trying again.
   */
  it.effect("treats a response with no content as a retryable failure", () =>
    Effect.gen(function* () {
      const written = yield* writeDraftWith([
        Response.makePart("reasoning", { text: "Thinking about how to open the post." }),
        Response.makePart("finish", { reason: "stop", usage })
      ])

      assert.isTrue(written._tag === "Left")
      if (written._tag !== "Left") return

      assert.strictEqual(written.left._tag, "DraftUnavailable")
      assert.isTrue(written.left.retryable)
      assert.include(written.left.reason, "no content")
    })
  )

  it.effect("treats content that is only whitespace the same way", () =>
    Effect.gen(function* () {
      const written = yield* writeDraftWith([
        Response.makePart("text", { text: "   \n  " }),
        Response.makePart("finish", { reason: "stop", usage })
      ])

      assert.isTrue(written._tag === "Left")
      if (written._tag !== "Left") return
      assert.isTrue(written.left.retryable)
    })
  )

  it.effect("falls back to the configured model when the provider does not say", () =>
    Effect.gen(function* () {
      const written = yield* writeDraftWith([
        Response.makePart("text", { text: "Spent the day on the collect stage." }),
        Response.makePart("finish", { reason: "stop", usage })
      ])

      assert.isTrue(written._tag === "Right")
      if (written._tag !== "Right") return
      assert.strictEqual(written.right.model, "moonshotai/kimi-k3")
    })
  )

  it.effect("reports a rate limit from the provider as worth trying again", () =>
    Effect.gen(function* () {
      const written = yield* writeDraftFailingWith(
        new AiError.HttpResponseError({
          module: "OpenRouter",
          method: "createChatCompletion",
          reason: "StatusCode",
          request: {
            method: "POST",
            url: "https://openrouter.ai/api/v1/chat/completions",
            urlParams: [],
            hash: Option.none(),
            headers: {}
          },
          response: { status: 429, headers: {} }
        })
      )

      assert.isTrue(written._tag === "Left")
      if (written._tag !== "Left") return

      // The point of the classification: being told to slow down is not a
      // reason to fail a User's Run, and the Run lifecycle is what acts on it.
      assert.isTrue(written.left.retryable)
      assert.include(written.left.reason, "rate limiting")
    })
  )

  it.effect("refuses a key the provider will not accept, rather than trying it again", () =>
    Effect.gen(function* () {
      const written = yield* writeDraftFailingWith(
        new AiError.HttpResponseError({
          module: "OpenRouter",
          method: "createChatCompletion",
          reason: "StatusCode",
          request: {
            method: "POST",
            url: "https://openrouter.ai/api/v1/chat/completions",
            urlParams: [],
            hash: Option.none(),
            headers: {}
          },
          response: { status: 401, headers: {} }
        })
      )

      assert.isTrue(written._tag === "Left")
      if (written._tag !== "Left") return
      assert.isFalse(written.left.retryable)
    })
  )
})

/**
 * What these drive: the two bounds the adapter composes in, from the outside.
 * Neither is visible in the port's vocabulary, and that is the point — a caller
 * asks for prose and gets either prose or a failure it already knows how to
 * classify, whether the provider hung or Ara's own budget was spent.
 */
describe("Bounding a model call", () => {
  const BOUNDED = new Map([
    ["DRAFT_MODEL", "moonshotai/kimi-k3"],
    ["MODEL_REQUEST_TIMEOUT", "5 seconds"],
    ["MODEL_RATE_LIMIT", "1"],
    ["MODEL_RATE_LIMIT_INTERVAL", "1 minutes"]
  ])

  const writerOver = (model: Layer.Layer<LanguageModel.LanguageModel>) =>
    LanguageModelDraftWriterLive.pipe(
      Layer.provide(model),
      Layer.provide(Layer.setConfigProvider(ConfigProvider.fromMap(BOUNDED)))
    )

  it.effect("gives up on a provider that never answers, and says it is worth trying again", () =>
    Effect.gen(function* () {
      const writing = yield* Effect.fork(
        Effect.flatMap(DraftWriter, (writer) => Effect.either(writer.writeDraft({ digest: A_DAY })))
      )

      yield* TestClock.adjust("5 seconds")
      const written = yield* Fiber.join(writing)

      assert.isTrue(written._tag === "Left")
      if (written._tag !== "Left") return

      assert.isTrue(written.left.retryable)
      assert.include(written.left.reason, "did not answer")
    }).pipe(Effect.provide(writerOver(modelThatNeverAnswers)))
  )

  it.effect("degrades a spent budget into a retryable failure rather than an unbounded wait", () =>
    Effect.gen(function* () {
      const write = Effect.flatMap(DraftWriter, (writer) => Effect.either(writer.writeDraft({ digest: A_DAY })))

      // The minute's one call.
      const first = yield* write
      assert.strictEqual(first._tag, "Right")

      // The second is not refused, it is queued — and the timeout is what stops
      // it queueing for the rest of the minute holding a worker.
      const queued = yield* Effect.fork(write)
      yield* TestClock.adjust("5 seconds")
      const second = yield* Fiber.join(queued)

      assert.isTrue(second._tag === "Left")
      if (second._tag !== "Left") return
      assert.isTrue(second.left.retryable)
    }).pipe(
      Effect.provide(
        writerOver(
          modelAnswering([
            Response.makePart("text", { text: "Spent the day on the collect stage." }),
            Response.makePart("finish", { reason: "stop", usage })
          ])
        )
      )
    )
  )
})
