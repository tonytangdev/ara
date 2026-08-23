import { Context, type Effect } from "effect"
import type { Installation } from "../installation.ts"
import type { UserId } from "../user.ts"

/**
 * Driven (outbound) port for App installations. An empty list is an ordinary
 * answer: being signed in and having installed nothing are separate facts.
 */
export class InstallationRepository extends Context.Tag("domain/connections/InstallationRepository")<
  InstallationRepository,
  {
    readonly record: (userId: UserId, installation: Installation) => Effect.Effect<void>
    readonly listFor: (userId: UserId) => Effect.Effect<ReadonlyArray<Installation>>
  }
>() {}
