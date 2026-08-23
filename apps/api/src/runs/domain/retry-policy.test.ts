import { assert, describe, it } from "@effect/vitest"
import { Duration } from "effect"
import { backoffFor, hasAttemptsLeft } from "./retry-policy.ts"

/**
 * What these tests drive: the arithmetic of backing off, with nothing waiting
 * on it. The policy is a pure function of the attempt number precisely so that
 * "does a Run wait longer each time" is a question about numbers rather than a
 * question about the clock.
 */

const BASE = Duration.seconds(2)
const CAP = Duration.minutes(2)

/** The middle of the jitter band, so the nominal delay is what is being read. */
const NO_JITTER = 1

const millisOf = (attempt: number, jitter = NO_JITTER) => Duration.toMillis(backoffFor(attempt, BASE, CAP, jitter))

describe("Waiting before trying a Run again", () => {
  it("doubles the wait with every attempt", () => {
    assert.strictEqual(millisOf(1), 2_000)
    assert.strictEqual(millisOf(2), 4_000)
    assert.strictEqual(millisOf(3), 8_000)
    assert.strictEqual(millisOf(4), 16_000)
  })

  it("stops doubling at the cap, however many attempts have been made", () => {
    assert.strictEqual(millisOf(20), Duration.toMillis(CAP))
    assert.strictEqual(millisOf(2_000), Duration.toMillis(CAP))
  })

  it("spreads Runs across the top half of the wait rather than bunching them", () => {
    // Two Runs that failed on the same rate limit draw different jitter and so
    // come back at different moments; neither comes back immediately.
    assert.strictEqual(millisOf(3, 0), 4_000)
    assert.strictEqual(millisOf(3, 0.5), 6_000)
    assert.strictEqual(millisOf(3, 1), 8_000)
  })

  it("never waits no time at all", () => {
    for (const jitter of [0, 0.01, 0.37, 0.99]) {
      assert.isAbove(millisOf(1, jitter), 0)
    }
  })
})

describe("The attempt ceiling", () => {
  it("gives a Run five attempts and no sixth", () => {
    assert.isTrue(hasAttemptsLeft(1, 5))
    assert.isTrue(hasAttemptsLeft(4, 5))
    assert.isFalse(hasAttemptsLeft(5, 5))
    // A Run that a crash and a requeue pushed past the ceiling stops too.
    assert.isFalse(hasAttemptsLeft(9, 5))
  })
})
