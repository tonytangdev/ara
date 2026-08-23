import { HttpApiBuilder, HttpApiClient } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { AraApi } from "../../../http/api.ts"
import { ApiLive } from "../../../http/server.ts"

const TestServer = HttpApiBuilder.serve().pipe(Layer.provide(ApiLive), Layer.provideMerge(NodeHttpServer.layerTest))

describe("GET /health", () => {
  it.effect("returns a healthy report", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(AraApi)
      const response = yield* client.health.check()
      assert.strictEqual(response.status, "healthy")
      assert.isAtLeast(response.uptimeSeconds, 0)
    }).pipe(Effect.provide(TestServer))
  )
})
