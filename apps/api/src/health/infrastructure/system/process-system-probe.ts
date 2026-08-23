import { Effect, Layer } from "effect"
import { SystemProbe } from "../../domain/ports/system-probe.ts"

/**
 * Driven (outbound) adapter backing `SystemProbe` with the Node process.
 * There are no external dependencies to probe yet, hence the empty list.
 */
export const ProcessSystemProbeLive = Layer.succeed(
  SystemProbe,
  SystemProbe.of({
    uptimeSeconds: Effect.sync(() => Math.round(process.uptime())),
    dependencies: Effect.succeed([])
  })
)
