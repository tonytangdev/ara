import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { DatabaseLive } from "./database/index.ts"
import { HttpLive } from "./http/server.ts"
import { RunsWorkerLive } from "./runs/index.ts"

/**
 * Composition root. The API and the worker run in one process for the MVP, so
 * there is one thing to deploy.
 *
 * `DatabaseLive` is provided once, here, to both halves at once: layer
 * memoization means the server and the worker share a single `SqlClient` and a
 * single connection pool, and the migrations it runs are finished before either
 * of them starts. The worker's fiber belongs to this launch's scope, so `Ctrl+C`
 * — or a platform's `SIGTERM` — interrupts it rather than orphaning it.
 */
const MainLive = Layer.mergeAll(HttpLive, RunsWorkerLive).pipe(Layer.provide(DatabaseLive))

Layer.launch(MainLive).pipe(NodeRuntime.runMain)
