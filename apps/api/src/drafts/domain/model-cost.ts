/** What the model charges, in US dollars per million tokens. */
export interface ModelPricing {
  readonly inputUsdPerMillionTokens: number
  readonly outputUsdPerMillionTokens: number
}

/** What the provider said the call consumed. Every count is nullable: a provider may decline to say. */
export interface TokenUsage {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly reasoningTokens: number | null
  readonly totalTokens: number | null
}

const PER_MILLION = 1_000_000

/** Six decimal places of a dollar. A single Draft costs fractions of a cent, and those add up. */
const USD_DECIMALS = 6

/**
 * What a call cost, in US dollars.
 *
 * Reasoning tokens are deliberately absent from the arithmetic. They are billed
 * at the output rate, but the provider already counts them inside the output
 * figure — OpenRouter reports them as `completion_tokens_details.reasoning_tokens`,
 * a breakdown of `completion_tokens` rather than an addition to it. Adding them
 * would double the largest number on a reasoning model's bill. They are recorded
 * beside the cost instead, because on Kimi K3 thinking is most of what is being
 * paid for and that deserves to be visible rather than inferred.
 *
 * An answer of `null` means the provider reported nothing at all to price. It
 * is not the same as zero, and a Draft is never lost over it.
 */
export const costOf = (usage: TokenUsage, pricing: ModelPricing): number | null => {
  if (usage.inputTokens === null && usage.outputTokens === null) return null

  const usd =
    ((usage.inputTokens ?? 0) * pricing.inputUsdPerMillionTokens +
      (usage.outputTokens ?? 0) * pricing.outputUsdPerMillionTokens) /
    PER_MILLION

  return Number(usd.toFixed(USD_DECIMALS))
}
