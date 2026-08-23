import { Context, type Effect, type Option } from "effect"
import type { ForgeCredential } from "../forge-credential.ts"
import type { UserId } from "../user.ts"

/**
 * Driven (outbound) port for the credentials a Forge issued to a User.
 * Encrypting them at rest is the adapter's responsibility, so no use case can
 * forget to do it.
 */
export class ForgeCredentialStore extends Context.Tag("domain/connections/ForgeCredentialStore")<
  ForgeCredentialStore,
  {
    readonly save: (userId: UserId, credential: ForgeCredential) => Effect.Effect<void>
    readonly find: (userId: UserId) => Effect.Effect<Option.Option<ForgeCredential>>
  }
>() {}
