import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { DependencyStatus } from "../domain/health-report.ts"
import { SystemProbe } from "../domain/ports/system-probe.ts"
import { CheckHealth } from "./check-health.ts"

const probeReturning = (dependencies: ReadonlyArray<DependencyStatus>) =>
  CheckHealth.Default.pipe(
    Layer.provide(
      Layer.succeed(
        SystemProbe,
        SystemProbe.of({
          uptimeSeconds: Effect.succeed(42),
          dependencies: Effect.succeed(dependencies)
        })
      )
    )
  )

describe("CheckHealth", () => {
  it.effect("is healthy when every dependency is reachable", () =>
    Effect.gen(function* () {
      const report = yield* Effect.flatMap(CheckHealth, (useCase) => useCase.execute)
      assert.strictEqual(report.state, "healthy")
      assert.strictEqual(report.uptimeSeconds, 42)
    }).pipe(Effect.provide(probeReturning([new DependencyStatus({ name: "db", reachable: true })])))
  )

  it.effect("is degraded when a dependency is unreachable", () =>
    Effect.gen(function* () {
      const report = yield* Effect.flatMap(CheckHealth, (useCase) => useCase.execute)
      assert.strictEqual(report.state, "degraded")
      assert.isFalse(report.isHealthy)
    }).pipe(Effect.provide(probeReturning([new DependencyStatus({ name: "db", reachable: false })])))
  )
})
