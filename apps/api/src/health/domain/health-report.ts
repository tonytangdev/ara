import { Schema } from "effect"

/**
 * The verdict the domain returns about the system's ability to serve traffic.
 */
export const HealthState = Schema.Literal("healthy", "degraded")
export type HealthState = typeof HealthState.Type

/**
 * A single dependency's contribution to the overall health verdict.
 */
export class DependencyStatus extends Schema.Class<DependencyStatus>("DependencyStatus")({
  name: Schema.String,
  reachable: Schema.Boolean
}) {}

/**
 * The domain model returned by the health check use case. It is transport
 * agnostic: adapters decide how to render it (JSON body, status code, ...).
 */
export class HealthReport extends Schema.Class<HealthReport>("HealthReport")({
  state: HealthState,
  uptimeSeconds: Schema.Number,
  dependencies: Schema.Array(DependencyStatus)
}) {
  static from(uptimeSeconds: number, dependencies: ReadonlyArray<DependencyStatus>): HealthReport {
    return new HealthReport({
      state: dependencies.every((dependency) => dependency.reachable) ? "healthy" : "degraded",
      uptimeSeconds,
      dependencies
    })
  }

  get isHealthy(): boolean {
    return this.state === "healthy"
  }
}
