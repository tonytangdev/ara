import { Context, Effect, Layer } from "effect"
import { GithubRateLimitConfig } from "../../../config.ts"
import { type KeyedRateLimiter, makeKeyedRateLimiter } from "../../../rate-limits/keyed-rate-limiter.ts"

/**
 * Ara's own budget for calling GitHub, kept per App installation.
 *
 * GitHub-shaped and therefore outside the Forge-agnostic ports (ADR-0003),
 * exactly like the token minting it sits beside: GitLab will meter its callers
 * on its own terms, and forcing both through one abstraction would invent a
 * shared budget that neither Forge has.
 *
 * Keyed by the installation's own external id, because that is the unit GitHub
 * charges against (ADR-0005). One User running a busy day of Runs spends their
 * own installation's budget and nobody else's, which is the property the App
 * model was chosen for in the first place.
 */
export class GithubRateLimiter extends Context.Tag("infrastructure/github/GithubRateLimiter")<
  GithubRateLimiter,
  KeyedRateLimiter
>() {}

/**
 * One limiter for the whole process, shared by every GitHub adapter.
 *
 * Exported as a layer *value* rather than rebuilt per caller so that layer
 * memoization gives reading a day of Activity and listing an installation's
 * repositories the same budget — two limiters would each grant a full quota and
 * together enforce twice the limit, which is no limit at all.
 */
export const GithubRateLimiterLive = Layer.scoped(
  GithubRateLimiter,
  Effect.flatMap(GithubRateLimitConfig, ({ interval, limit }) => makeKeyedRateLimiter({ limit, interval }))
)
