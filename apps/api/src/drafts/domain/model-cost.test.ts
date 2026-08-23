import { assert, describe, it } from "@effect/vitest"
import { costOf } from "./model-cost.ts"

/** A dollar per million in, ten per million out: arithmetic anyone can check by eye. */
const pricing = { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 10 }

describe("Pricing a model call", () => {
  it("charges input and output at their own rates", () => {
    const usd = costOf(
      { inputTokens: 1_000_000, outputTokens: 100_000, reasoningTokens: null, totalTokens: 1_100_000 },
      pricing
    )

    assert.strictEqual(usd, 2)
  })

  it("does not charge for thinking twice", () => {
    // The provider reports reasoning as a breakdown of the output tokens, not
    // as an addition to them. On a reasoning model that is most of the output,
    // so adding it would roughly double every bill Ara reports.
    const withThinking = costOf(
      { inputTokens: 0, outputTokens: 3_000, reasoningTokens: 2_700, totalTokens: 3_000 },
      pricing
    )
    const withoutThinking = costOf(
      { inputTokens: 0, outputTokens: 3_000, reasoningTokens: null, totalTokens: 3_000 },
      pricing
    )

    assert.strictEqual(withThinking, withoutThinking)
  })

  it("says nothing rather than zero when the provider reported no usage", () => {
    const usd = costOf({ inputTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null }, pricing)

    // A Draft that cost nothing and a Draft nobody priced are different facts,
    // and a Draft is never lost over the difference.
    assert.isNull(usd)
  })

  it("prices what it was told when only half the counts arrived", () => {
    const usd = costOf({ inputTokens: 2_000, outputTokens: null, reasoningTokens: null, totalTokens: null }, pricing)

    assert.strictEqual(usd, 0.002)
  })

  it("keeps fractions of a cent", () => {
    const usd = costOf({ inputTokens: 1, outputTokens: 1, reasoningTokens: null, totalTokens: 2 }, pricing)

    assert.strictEqual(usd, 0.000011)
  })
})
