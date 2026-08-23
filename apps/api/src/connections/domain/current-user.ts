import { Context } from "effect"
import type { User } from "./user.ts"

/**
 * The User a request is being served on behalf of. Nothing puts this in context
 * except the authentication middleware, so a handler that asks for it cannot be
 * reached without a valid session.
 */
export class CurrentUser extends Context.Tag("domain/connections/CurrentUser")<CurrentUser, User>() {}
