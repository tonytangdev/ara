import { Effect, HashMap, Option, RateLimiter, Ref, Scope } from "effect"

/**
 * A rate limiter that keeps a separate budget per key.
 *
 * The keys are whatever the budget actually belongs to — a GitHub App
 * installation, per ADR-0005 — rather than a process-wide "calls to GitHub".
 * That distinction is the whole point: a shared budget means one busy User can
 * spend everyone else's, which is precisely what the App model exists to
 * prevent, and enforcing it here rather than at each call site is what keeps
 * the rule from being something a new endpoint can forget.
 *
 * Only the *start* of a task is limited, not how many run at once. Waiting for
 * a turn is normal and is not an error; what turns a saturated budget into a
 * failure is the timeout a caller wraps around it, and that failure is
 * retryable by construction — the budget refills on its own.
 */
export interface KeyedRateLimiter {
  readonly apply: <A, E, R>(key: string, task: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/**
 * Build one, holding its limiters for as long as the enclosing scope lives.
 *
 * The limiters are made lazily and then kept: a limiter that was rebuilt per
 * call would hand out a full budget every time and limit nothing. They are
 * extended into the scope this is built in — the layer's, in practice — so a
 * limiter created halfway through the application's life is still finalized
 * with it and not with whichever Run happened to create it.
 *
 * The map is unbounded, which is the honest reading of what it holds: one small
 * entry per installation Ara has ever read from since boot, and an Ara with
 * more installations than that fits in memory has larger problems.
 */
export const makeKeyedRateLimiter = (
  options: RateLimiter.RateLimiter.Options
): Effect.Effect<KeyedRateLimiter, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const limiters = yield* Ref.make(HashMap.empty<string, RateLimiter.RateLimiter>())
    // Creating a limiter is check-then-set, and two Runs for the same
    // installation can arrive at once. Without this, both would look, both
    // would find nothing, and one budget would quietly replace the other.
    const oneCreationAtATime = yield* Effect.makeSemaphore(1)

    const create = (key: string) =>
      oneCreationAtATime.withPermits(1)(
        Effect.gen(function* () {
          const known = yield* Ref.get(limiters)
          const raced = HashMap.get(known, key)
          if (Option.isSome(raced)) return raced.value

          const limiter = yield* RateLimiter.make(options).pipe(Scope.extend(scope))
          yield* Ref.update(limiters, HashMap.set(key, limiter))
          return limiter
        })
      )

    const limiterFor = (key: string) =>
      Effect.flatMap(Ref.get(limiters), (known) =>
        Option.match(HashMap.get(known, key), { onSome: Effect.succeed, onNone: () => create(key) })
      )

    const apply = <A, E, R>(key: string, task: Effect.Effect<A, E, R>) =>
      Effect.flatMap(limiterFor(key), (limit) => limit(task))

    return { apply }
  })
