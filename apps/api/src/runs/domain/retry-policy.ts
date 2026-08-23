import { Duration } from "effect"

/**
 * How long to wait before attempting a Run again: exponential, jittered, capped.
 *
 * Exponential because a provider that is unwell is rarely well again a second
 * later, and asking harder is how a bad minute becomes a bad hour. Jittered
 * because several Runs that hit the same rate limit would otherwise back off in
 * step and come back in step, recreating the burst they were backing off from.
 * Capped because doubling is only sensible while the numbers are small.
 *
 * `jitter` is a number in `[0, 1)` — `Random.next` — and is taken as an
 * argument rather than drawn here so that this stays a pure function anybody
 * can read the arithmetic of, and a test can pin.
 *
 * The jitter is applied over the top half of the delay: an attempt waits
 * between 50% and 100% of its nominal backoff, which spreads Runs out without
 * ever collapsing the wait to nothing.
 */
export const backoffFor = (
  attempt: number,
  base: Duration.Duration,
  cap: Duration.Duration,
  jitter: number
): Duration.Duration => {
  // Bounded before it is used: `2 ** 1024` is `Infinity`, and a Run that has
  // somehow been attempted that often should still wait a finite time.
  const doublings = Math.min(Math.max(attempt - 1, 0), 30)
  const bounded = Duration.min(Duration.times(base, 2 ** doublings), cap)

  return Duration.times(bounded, 0.5 + jitter / 2)
}

/**
 * Whether a Run that has been attempted this many times gets another go.
 *
 * `attempts` counts attempts and not retries, so five means five: the first try
 * and four more. A Run that reaches the ceiling stops, whatever the failure
 * said — which is the difference between a Run that recovers and a Run that
 * burns budget forever.
 */
export const hasAttemptsLeft = (attempts: number, maxAttempts: number): boolean => attempts < maxAttempts
