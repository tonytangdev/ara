import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "@effect/platform"
import { Schema } from "effect"

/** Transport-facing representation of a `HealthReport`. */
export class HealthResponse extends Schema.Class<HealthResponse>("HealthResponse")({
  status: Schema.Literal("healthy", "degraded"),
  uptimeSeconds: Schema.Number,
  dependencies: Schema.Array(Schema.Struct({
    name: Schema.String,
    reachable: Schema.Boolean
  }))
}) {}

/** Returned with a 503 so load balancers can take the instance out of rotation. */
export class Unhealthy extends Schema.TaggedError<Unhealthy>()(
  "Unhealthy",
  { report: HealthResponse },
  HttpApiSchema.annotations({ status: 503 })
) {}

export class HealthApiGroup extends HttpApiGroup.make("health")
  .add(
    HttpApiEndpoint.get("check", "/health")
      .addSuccess(HealthResponse)
      .addError(Unhealthy)
      .annotate(OpenApi.Summary, "Liveness and readiness probe")
  )
{}
