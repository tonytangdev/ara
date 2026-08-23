import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { HttpLive } from "./http/server.ts"

Layer.launch(HttpLive).pipe(NodeRuntime.runMain)
