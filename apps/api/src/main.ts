import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { DatabaseLive } from "./database/index.ts"
import { HttpLive } from "./http/server.ts"

/**
 * Composition root. `DatabaseLive` is provided once, here, so the whole
 * application shares one connection pool and the migrations it runs are
 * finished before the server binds.
 */
const MainLive = HttpLive.pipe(Layer.provide(DatabaseLive))

Layer.launch(MainLive).pipe(NodeRuntime.runMain)
