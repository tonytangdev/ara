import { HttpApiBuilder, HttpMiddleware, HttpServer } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { createServer } from "node:http"
import { ServerConfig } from "../config.ts"
import { HealthLive } from "../health/index.ts"
import { AraApi } from "./api.ts"

/** The API implementation: every module, wired. Add new modules here. */
export const ApiLive = HttpApiBuilder.api(AraApi).pipe(
  Layer.provide(HealthLive)
)

const NodeServerLive = Layer.unwrapEffect(
  Effect.map(ServerConfig, ({ host, port }) => NodeHttpServer.layer(createServer, { host, port }))
)

/** Everything needed to actually listen on a socket. */
export const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(ApiLive),
  HttpServer.withLogAddress,
  Layer.provide(NodeServerLive)
)
