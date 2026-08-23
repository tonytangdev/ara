import { HttpApi, OpenApi } from "@effect/platform"
import { HealthApiGroup } from "../health/api.ts"

/** The driving (inbound) HTTP port description. */
export class AraApi extends HttpApi.make("ara")
  .add(HealthApiGroup)
  .annotate(OpenApi.Title, "Ara API")
  .annotate(OpenApi.Version, "0.0.0")
  .annotate(OpenApi.Description, "HTTP surface of the Ara services.") {}
