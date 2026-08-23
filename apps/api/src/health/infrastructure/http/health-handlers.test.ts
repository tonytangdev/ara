import { HttpApi, HttpApiBuilder, HttpApiClient } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { HealthApiGroup } from "../../api.ts"
import { CheckHealth } from "../../application/check-health.ts"
import { DependencyStatus } from "../../domain/health-report.ts"
import { SystemProbe } from "../../domain/ports/system-probe.ts"
import { HealthHandlersLive } from "./health-handlers.ts"

/**
 * The health module alone, served under the real API's id, so these tests need
 * nothing from the other modules. `HealthHandlersLive` is the same layer the
 * application uses: it registers the group by name, not by which `HttpApi`
 * value it was handed.
 */
const HealthOnlyApi = HttpApi.make("ara").add(HealthApiGroup)

/**
 * Real handlers, real use case; only the driven port is stubbed, so these tests
 * are about what HTTP says, not about what the probe can reach.
 */
const serverReporting = (dependencies: ReadonlyArray<DependencyStatus>) =>
  HttpApiBuilder.serve().pipe(
    Layer.provide(
      HttpApiBuilder.api(HealthOnlyApi).pipe(
        Layer.provide(
          HealthHandlersLive.pipe(
            Layer.provide(CheckHealth.Default),
            Layer.provide(
              Layer.succeed(
                SystemProbe,
                SystemProbe.of({
                  uptimeSeconds: Effect.succeed(7),
                  dependencies: Effect.succeed(dependencies)
                })
              )
            )
          )
        )
      )
    ),
    Layer.provideMerge(NodeHttpServer.layerTest)
  )

describe("GET /health", () => {
  it.effect("returns a healthy report listing each dependency", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(HealthOnlyApi)
      const response = yield* client.health.check()
      assert.strictEqual(response.status, "healthy")
      assert.isAtLeast(response.uptimeSeconds, 0)
      assert.deepStrictEqual(response.dependencies, [{ name: "database", reachable: true }])
    }).pipe(Effect.provide(serverReporting([new DependencyStatus({ name: "database", reachable: true })])))
  )

  it.effect("reports unhealthy when a dependency is unreachable", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(HealthOnlyApi)
      const error = yield* Effect.flip(client.health.check())
      if (error._tag !== "Unhealthy") return assert.fail(`expected Unhealthy, got ${error._tag}`)
      assert.strictEqual(error.report.status, "degraded")
      assert.deepStrictEqual(error.report.dependencies, [{ name: "database", reachable: false }])
    }).pipe(Effect.provide(serverReporting([new DependencyStatus({ name: "database", reachable: false })])))
  )
})
