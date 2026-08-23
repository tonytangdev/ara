import { Effect } from "effect"
import { HealthReport } from "../domain/health-report.ts"
import { SystemProbe } from "../domain/ports/system-probe.ts"

/**
 * Driving (inbound) port: the use case any adapter can call. It depends only on
 * the outbound `SystemProbe` port, never on HTTP or Node.
 */
export class CheckHealth extends Effect.Service<CheckHealth>()("application/health/CheckHealth", {
  effect: Effect.gen(function*() {
    const probe = yield* SystemProbe

    const execute = Effect.gen(function*() {
      const [uptimeSeconds, dependencies] = yield* Effect.all([probe.uptimeSeconds, probe.dependencies], {
        concurrency: "unbounded"
      })
      return HealthReport.from(uptimeSeconds, dependencies)
    })

    return { execute } as const
  })
}) {}
