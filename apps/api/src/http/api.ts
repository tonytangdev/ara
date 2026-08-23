import { HttpApi } from "@effect/platform"
import { HealthApiGroup } from "../health/api.ts"

/** The driving (inbound) HTTP port description. */
export class AraApi extends HttpApi.make("ara").add(HealthApiGroup) {}
