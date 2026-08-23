import { HttpApi, OpenApi } from "@effect/platform"
import { ConnectionsApiGroup, RepoConnectionsApiGroup } from "../connections/api.ts"
import { HealthApiGroup } from "../health/api.ts"
import { RunsApiGroup } from "../runs/api.ts"

/** The driving (inbound) HTTP port description. */
export class AraApi extends HttpApi.make("ara")
  .add(HealthApiGroup)
  .add(ConnectionsApiGroup)
  .add(RepoConnectionsApiGroup)
  .add(RunsApiGroup)
  .annotate(OpenApi.Title, "Ara API")
  .annotate(OpenApi.Version, "0.0.0")
  .annotate(OpenApi.Description, "HTTP surface of the Ara services.") {}
