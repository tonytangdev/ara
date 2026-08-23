import { type AiError, LanguageModel } from "@effect/ai"
import { Effect, Layer, Option } from "effect"
import { DraftConfig } from "../../../config.ts"
import { isBlank, WrittenDraft } from "../../domain/draft.ts"
import { instructionFor } from "../../domain/draft-instruction.ts"
import { type DraftBrief, DraftUnavailable, DraftWriter } from "../../domain/ports/draft-writer.ts"

/**
 * Which failures are worth trying again.
 *
 * Rate limits, server errors and a request that never completed are the
 * provider having a bad minute. A refused key or a model that does not exist is
 * configuration, and retrying it burns quota to learn nothing.
 */
const isTransientStatus = (status: number): boolean =>
  status === 408 || status === 409 || status === 429 || status >= 500

const toDraftUnavailable = (error: AiError.AiError): DraftUnavailable => {
  switch (error._tag) {
    case "HttpResponseError":
      return new DraftUnavailable({
        reason: `The model provider answered ${error.response.status}.`,
        retryable: isTransientStatus(error.response.status)
      })
    case "HttpRequestError":
      return new DraftUnavailable({
        reason: "The model provider could not be reached.",
        retryable: true
      })
    default:
      return new DraftUnavailable({ reason: error.message, retryable: false })
  }
}

/** Undefined usage is a provider that did not say, not a Draft that cost nothing. */
const countOf = (tokens: number | undefined): number | null => (tokens === undefined ? null : tokens)

/**
 * Driven (outbound) adapter writing a Draft with a language model.
 *
 * It depends on `@effect/ai`'s provider-agnostic `LanguageModel` tag and on
 * nothing from any provider's package. Which provider satisfies that tag is
 * decided where the module is composed, so OpenRouter can be swapped for
 * something else without this file — or any use case — changing.
 *
 * The rule this adapter exists to keep: a response can be a perfectly good
 * HTTP 200 carrying reasoning and no message content. The prototype saw it once
 * in twenty-four calls. `generateText` concatenates the text parts, so that
 * arrives here as an empty string, and an adapter that did not look would
 * persist an empty Draft. It is a retryable failure and never prose.
 *
 * The model that answered is taken from the response where the provider reports
 * it, and from configuration where it does not, so a Draft records what wrote
 * it rather than what was asked to.
 */
export const LanguageModelDraftWriterLive = Layer.effect(
  DraftWriter,
  Effect.gen(function* () {
    const { model: configuredModel } = yield* DraftConfig
    const languageModel = yield* LanguageModel.LanguageModel

    const writeDraft = (brief: DraftBrief) =>
      Effect.gen(function* () {
        const instruction = instructionFor(brief.digest)

        const response = yield* languageModel
          .generateText({
            prompt: [
              { role: "system", content: instruction.voice },
              { role: "user", content: instruction.brief }
            ]
          })
          .pipe(Effect.mapError(toDraftUnavailable))

        if (isBlank(response.text)) {
          return yield* Effect.fail(
            new DraftUnavailable({
              reason: `The model answered with no content (finish reason: ${response.finishReason}).`,
              retryable: true
            })
          )
        }

        const reported = response.content.find((part) => part.type === "response-metadata")

        return new WrittenDraft({
          body: response.text.trim(),
          model: reported === undefined ? configuredModel : Option.getOrElse(reported.modelId, () => configuredModel),
          inputTokens: countOf(response.usage.inputTokens),
          outputTokens: countOf(response.usage.outputTokens),
          totalTokens: countOf(response.usage.totalTokens)
        })
      })

    return DraftWriter.of({ writeDraft })
  })
)
