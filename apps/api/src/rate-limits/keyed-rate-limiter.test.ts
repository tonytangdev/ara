import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Ref, TestClock } from "effect"
import { makeKeyedRateLimiter } from "./keyed-rate-limiter.ts"

/**
 * What this test drives: the property the whole ticket rests on — that one
 * caller's budget is not everybody's. The clock is the test's, so nothing here
 * waits in real time for a limit to refill.
 */
describe("A rate limiter kept per key", () => {
  it.effect("makes a caller wait once its own budget is spent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const limiter = yield* makeKeyedRateLimiter({ limit: 2, interval: "1 minutes" })
        const done = yield* Ref.make(0)

        const call = limiter.apply(
          "installation-42",
          Ref.update(done, (made) => made + 1)
        )

        yield* Effect.fork(Effect.all([call, call, call], { concurrency: 1 }))
        yield* TestClock.adjust("0 millis")

        // Two through, the third holding the door: the budget is the budget.
        assert.strictEqual(yield* Ref.get(done), 2)

        yield* TestClock.adjust("1 minutes")
        assert.strictEqual(yield* Ref.get(done), 3)
      })
    )
  )

  it.effect("does not let one key spend another's budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const limiter = yield* makeKeyedRateLimiter({ limit: 1, interval: "1 minutes" })
        const done = yield* Ref.make<ReadonlyArray<string>>([])

        const call = (key: string) =>
          limiter.apply(
            key,
            Ref.update(done, (made) => [...made, key])
          )

        yield* Effect.fork(call("installation-42"))
        yield* Effect.fork(call("installation-42"))
        const other = yield* Effect.fork(call("installation-99"))
        yield* TestClock.adjust("0 millis")

        // The busy installation is one call deep in its own minute; the quiet
        // one is not made to wait behind it.
        yield* Fiber.join(other)
        assert.deepStrictEqual(yield* Ref.get(done), ["installation-42", "installation-99"])
      })
    )
  )

  it.effect("keeps a key's limiter rather than handing out a fresh budget each call", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const limiter = yield* makeKeyedRateLimiter({ limit: 1, interval: "1 minutes" })
        const done = yield* Ref.make(0)

        const call = limiter.apply(
          "installation-42",
          Ref.update(done, (made) => made + 1)
        )

        yield* Effect.fork(call)
        yield* TestClock.adjust("0 millis")
        assert.strictEqual(yield* Ref.get(done), 1)

        // A limiter rebuilt per call would let this straight through, and would
        // be a rate limiter that limits nothing.
        yield* Effect.fork(call)
        yield* TestClock.adjust("0 millis")
        assert.strictEqual(yield* Ref.get(done), 1)
      })
    )
  )
})
