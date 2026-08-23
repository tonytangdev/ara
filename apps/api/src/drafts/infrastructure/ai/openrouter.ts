import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter"
import { Effect, Layer } from "effect"
import { DraftConfig, ModelProviderConfig } from "../../../config.ts"

/**
 * The edge: the one place a provider is named.
 *
 * `@effect/ai`'s `LanguageModel` tag is what the rest of the module depends on,
 * and this is what satisfies it. Both halves are configuration — which model,
 * and where to reach it — so comparing Kimi K3 against something else is an
 * environment variable, and moving off OpenRouter is this file.
 *
 * OpenRouter rather than Moonshot directly, deliberately: `@effect/ai-openai`
 * speaks only the Responses API and Moonshot implements only Chat Completions.
 *
 * `HttpClient` is left as a requirement so the module is composed against the
 * same client as everything else rather than opening its own.
 */
export const OpenRouterLanguageModelLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const { model } = yield* DraftConfig
    const { apiKey, apiUrl } = yield* ModelProviderConfig

    return OpenRouterLanguageModel.layer({ model }).pipe(Layer.provide(OpenRouterClient.layer({ apiKey, apiUrl })))
  })
)
