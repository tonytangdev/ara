import { LanguageModel, Response } from "@effect/ai"
import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Option, Stream } from "effect"
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

const TestConfig = Layer.setConfigProvider(ConfigProvider.fromMap(new Map([["DRAFT_MODEL", "moonshotai/kimi-k3"]])))

const usage = { inputTokens: 1_200, outputTokens: 300, totalTokens: 4_100 }

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
      assert.strictEqual(written.right.outputTokens, 300)
      // Not the sum of the other two: most of what a reasoning model bills for
      // is thinking, and that is exactly why the number is worth persisting.
      assert.strictEqual(written.right.totalTokens, 4_100)
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
})
