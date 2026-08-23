import { Layer } from "effect"
import { CheckHealth } from "./application/check-health.ts"
import { HealthHandlersLive } from "./infrastructure/http/health-handlers.ts"
import { RuntimeSystemProbeLive } from "./infrastructure/system/runtime-system-probe.ts"

/**
 * The health module's public face. Nothing outside this folder should import
 * anything deeper than these two exports:
 *
 * - `./api.ts` — the HTTP contract this module contributes to the API surface.
 * - `HealthLive` — the module, fully wired: handlers, use case, driven adapters.
 *
 * Swap `RuntimeSystemProbeLive` here and the rest of the app is untouched. The
 * `SqlClient` it needs is left as a requirement, so the composition root
 * decides which Postgres the module probes.
 */
export const HealthLive = HealthHandlersLive.pipe(
  Layer.provide(CheckHealth.Default),
  Layer.provide(RuntimeSystemProbeLive)
)

export { HealthApiGroup, HealthResponse, Unhealthy } from "./api.ts"
