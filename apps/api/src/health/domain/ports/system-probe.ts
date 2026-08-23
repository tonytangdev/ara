import { Context, type Effect } from "effect"
import type { DependencyStatus } from "../health-report.ts"

/**
 * Driven (outbound) port. The domain asks "how is the system doing?" without
 * knowing whether the answer comes from `process`, a database ping, or a stub.
 */
export class SystemProbe extends Context.Tag("domain/health/SystemProbe")<
  SystemProbe,
  {
    readonly uptimeSeconds: Effect.Effect<number>
    readonly dependencies: Effect.Effect<ReadonlyArray<DependencyStatus>>
  }
>() {}
