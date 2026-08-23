import { Schema } from "effect"
import { Forge } from "./forge.ts"

export const UserId = Schema.UUID.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

/**
 * What a Forge told us about the person signing in. Identity is
 * `(forge, forgeUserId)` — never the login, which people rename.
 */
export class ForgeIdentity extends Schema.Class<ForgeIdentity>("ForgeIdentity")({
  forge: Forge,
  forgeUserId: Schema.String,
  login: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String)
}) {}

/**
 * The person whose work is being written about. Created on first sign-in and
 * resolved by identity on every sign-in after that.
 */
export class User extends Schema.Class<User>("User")({
  id: UserId,
  forge: Forge,
  forgeUserId: Schema.String,
  login: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String)
}) {}
