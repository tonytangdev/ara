import { HttpApi, OpenApi } from "@effect/platform"
import { ConnectionsApiGroup } from "../connections/api.ts"
import { HealthApiGroup } from "../health/api.ts"

/** The driving (inbound) HTTP port description. */
export class AraApi extends HttpApi.make("ara")
  .add(HealthApiGroup)
  .add(ConnectionsApiGroup)
  .annotate(OpenApi.Title, "Ara API")
  .annotate(OpenApi.Version, "0.0.0")
  .annotate(OpenApi.Description, "HTTP surface of the Ara services.") {}
