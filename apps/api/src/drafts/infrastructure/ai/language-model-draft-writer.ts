import { type AiError, LanguageModel } from "@effect/ai"
import { Duration, Effect, Layer, Option, RateLimiter } from "effect"
import { DraftConfig, ModelCallConfig, ModelPricingConfig } from "../../../config.ts"
import { isBlank, WrittenDraft } from "../../domain/draft.ts"
import { instructionFor } from "../../domain/draft-instruction.ts"
import { costOf } from "../../domain/model-cost.ts"
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
        reason:
          error.response.status === 429
            ? "The model provider is rate limiting Ara."
            : `The model provider answered ${error.response.status}.`,
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
 *
 * The rate limit and the timeout live here rather than at the call sites, and
 * that placement is the design: every route to the model goes through this one
 * function, so "model calls are limited and bounded" is a property of the port
 * being satisfied at all rather than a discipline each new caller has to keep.
 * A saturated limiter and a provider that stopped answering both come out of
 * the timeout as the same thing — a retryable `DraftUnavailable` — because both
 * are worth trying again in a minute, and neither is worth failing a Run over
 * on the spot. Doing the trying is the Run lifecycle's job, not this adapter's.
 *
 * What a call cost is computed here because pricing is a fact about the
 * provider, and recorded on the Draft because "what is this habit costing" is a
 * question asked of Drafts and Runs long after the call is over.
 */
export const LanguageModelDraftWriterLive = Layer.scoped(
  DraftWriter,
  Effect.gen(function* () {
    const { model: configuredModel } = yield* DraftConfig
    const { interval, limit, requestTimeout } = yield* ModelCallConfig
    const pricing = yield* ModelPricingConfig
    const languageModel = yield* LanguageModel.LanguageModel
    const rateLimit = yield* RateLimiter.make({ limit, interval })

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
          .pipe(
            Effect.mapError(toDraftUnavailable),
            rateLimit,
            Effect.timeoutFail({
              duration: requestTimeout,
              onTimeout: () =>
                new DraftUnavailable({
                  reason: `The model did not answer within ${Duration.format(requestTimeout)}.`,
                  retryable: true
                })
            })
          )

        if (isBlank(response.text)) {
          return yield* Effect.fail(
            new DraftUnavailable({
              reason: `The model answered with no content (finish reason: ${response.finishReason}).`,
              retryable: true
            })
          )
        }

        const reported = response.content.find((part) => part.type === "response-metadata")

        const usage = {
          inputTokens: countOf(response.usage.inputTokens),
          outputTokens: countOf(response.usage.outputTokens),
          reasoningTokens: countOf(response.usage.reasoningTokens),
          totalTokens: countOf(response.usage.totalTokens)
        }

        return new WrittenDraft({
          body: response.text.trim(),
          model: reported === undefined ? configuredModel : Option.getOrElse(reported.modelId, () => configuredModel),
          ...usage,
          costUsd: costOf(usage, pricing)
        })
      })

    return DraftWriter.of({ writeDraft })
  })
)
