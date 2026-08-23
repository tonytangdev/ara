import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { CheckHealth } from "../../application/check-health.ts"
import type { HealthReport } from "../../domain/health-report.ts"
import { AraApi } from "../../../http/api.ts"
import { HealthResponse, Unhealthy } from "../../api.ts"

const toResponse = (report: HealthReport): HealthResponse =>
  new HealthResponse({
    status: report.state,
    uptimeSeconds: report.uptimeSeconds,
    dependencies: report.dependencies
  })

/**
 * Driving (inbound) adapter: translates HTTP calls into use case calls and the
 * domain model back into a transport payload.
 */
export const HealthHandlersLive = HttpApiBuilder.group(AraApi, "health", (handlers) =>
  handlers.handle("check", () =>
    Effect.gen(function*() {
      const checkHealth = yield* CheckHealth
      const report = yield* checkHealth.execute
      const response = toResponse(report)
      return report.isHealthy ? response : yield* new Unhealthy({ report: response })
    })))
