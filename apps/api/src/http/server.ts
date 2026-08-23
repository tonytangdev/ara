import { createServer } from "node:http"
import { HttpApiBuilder, HttpServer } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { ServerConfig } from "../config.ts"
import { ConnectionsLive } from "../connections/index.ts"
import { DigestsLive } from "../digests/index.ts"
import { HealthLive } from "../health/index.ts"
import { RunsLive } from "../runs/index.ts"
import { AraApi } from "./api.ts"
import { DocsLive } from "./docs.ts"
import { RequestLogger } from "./logging.ts"

/**
 * The API implementation: every module, wired. Add new modules here.
 *
 * `SqlClient` is left as a requirement rather than provided: the composition
 * root supplies it, and tests supply a disposable one.
 */
export const ApiLive = HttpApiBuilder.api(AraApi).pipe(
  Layer.provide(HealthLive),
  // Runs and Digests are always somebody's, so both modules' endpoints declare
  // the connections module's authentication middleware. `provideMerge` is what
  // satisfies that: the middleware goes into the runs handlers *and* stays in
  // the layer's output, where the API builder looks for it.
  Layer.provide(Layer.mergeAll(RunsLive, DigestsLive).pipe(Layer.provideMerge(ConnectionsLive)))
)

const NodeServerLive = Layer.unwrapEffect(
  Effect.map(ServerConfig, ({ host, port }) => NodeHttpServer.layer(createServer, { host, port }))
)

/** Everything needed to actually listen on a socket. */
export const HttpLive = HttpApiBuilder.serve(RequestLogger).pipe(
  Layer.provide(DocsLive),
  Layer.provide(ApiLive),
  HttpServer.withLogAddress,
  Layer.provide(NodeServerLive)
)
